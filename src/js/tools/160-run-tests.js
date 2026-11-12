// Workspace source execution and host-enforced read-only tests.
// run_tests is top-level only. Host snapshots, immutable grants/deadline, and
// frame-bound policy are authoritative; the sandbox harness is diagnostics only.
// ALL live mutations (including scratch) are unsupported. Contract/runtime
// layers are explicitly skipped, never reported as successful live contracts.
// Legacy allow_tools:['name'] grants are rejected; use constrained action grants.
// This does NOT change CSP or prevent arbitrary JS direct fetch/network traffic.

var RUN_TESTS_DEFAULT_TAGS = ['unit', 'contract', 'canary'];
var RUN_TESTS_KNOWN_TAGS = ['unit', 'contract', 'runtime', 'canary'];
var RUN_TESTS_DEFAULT_TIMEOUT_MS = 120000;
var RUN_TESTS_DEFAULT_TEST_TIMEOUT_MS = 30000;
// Parallel shards: each shard is its own exact-frame sandbox + registry context.
var RUN_TESTS_DEFAULT_SHARDS = 4;
var RUN_TESTS_MAX_SHARDS = 8;
var RUN_TESTS_DEFAULT_MS_PER_TEST = 30;
var RUN_TESTS_HARNESS_PATH = 'test/harness.js';
var RUN_JS_FILE_MODES = ['module', 'script', 'source'];
// Explicit files:[…] must be harness test files — the sandbox program evals
// whatever it is given, so an arbitrary path would run with the test globals.
var RUN_TESTS_FILE_RE = /^test\/[^\0]*\.test\.js$/;

// Realm-aware dev-mode probe (mirrors core/140-skills-engine.js _devModeActiveSync,
// which may not be bundled in every realm this file runs in). Threaded into the
// harness as cfg.dev_mode so `runtime`-tagged tests are skipped outside dev mode.
function rtDevModeActive() {
    try {
        if (typeof _devModeActiveSync === 'function') return !!_devModeActiveSync();
        if (typeof Platform !== 'undefined' && Platform && Platform.isWorker) return !!self._swDevModeActive;
        return !!(typeof window !== 'undefined' && window._pageDevModeActive);
    } catch (e) { return false; }
}

// ─── pure helpers ────────────────────────────────────────────────────────────

function rjfValidateArgs(args) {
    args = args || {};
    if (typeof args.path !== 'string' || !args.path.trim()) return { ok: false, error: 'path is required (workspace-relative, e.g. "src/js/core/030-config.js")' };
    var mode = args.mode == null ? 'module' : String(args.mode);
    if (RUN_JS_FILE_MODES.indexOf(mode) < 0) return { ok: false, error: 'mode must be one of: ' + RUN_JS_FILE_MODES.join(', ') };
    if (args.args != null && (typeof args.args !== 'object' || Array.isArray(args.args))) return { ok: false, error: 'args must be an object when provided' };
    return { ok: true, value: { path: args.path.trim(), mode: mode, args: args.args || {}, workspace: args.workspace || undefined } };
}

function rtValidateArgs(args) {
    args = args || {};
    if (args.files != null && (!Array.isArray(args.files) || !args.files.every(function(f) { return typeof f === 'string' && f.trim(); }))) {
        return { ok: false, error: 'files must be an array of workspace paths' };
    }
    if (args.files != null) {
        var badFiles = args.files.map(function(f) { return f.trim(); }).filter(function(f) { return (!RUN_TESTS_FILE_RE.test(f) || !TestRunPolicy.canonical(f)); });
        if (badFiles.length) return { ok: false, error: 'files must match ^test/.*\\.test\\.js$ (got: ' + badFiles.join(', ') + ')' };
    }
    var allowed;
    try { allowed = TestRunPolicy.grants(args.allow_tools); } catch (e) { return { ok: false, error: e.message }; }
    if (args.pattern != null) {
        try { new RegExp(String(args.pattern)); } catch (e) { return { ok: false, error: 'pattern is not a valid regex: ' + e.message }; }
    }
    var tags = args.tags == null ? RUN_TESTS_DEFAULT_TAGS.slice() : args.tags;
    if (!Array.isArray(tags) || !tags.length || !tags.every(function(t) { return typeof t === 'string'; })) return { ok: false, error: 'tags must be a non-empty array of strings' };
    var unknown = tags.filter(function(t) { return RUN_TESTS_KNOWN_TAGS.indexOf(t) < 0; });
    if (unknown.length) return { ok: false, error: 'unknown tags: ' + unknown.join(', ') + ' (known: ' + RUN_TESTS_KNOWN_TAGS.join(', ') + ')' };
    var timeout = args.timeout_ms == null ? RUN_TESTS_DEFAULT_TIMEOUT_MS : Number(args.timeout_ms);
    if (!isFinite(timeout) || timeout <= 0 || timeout > 600000) return { ok: false, error: 'timeout_ms must be a positive number at most 600000 (10 minutes)' };
    var testTimeout = args.test_timeout_ms == null ? RUN_TESTS_DEFAULT_TEST_TIMEOUT_MS : Number(args.test_timeout_ms);
    if (!isFinite(testTimeout) || testTimeout <= 0 || testTimeout > 600000) return { ok: false, error: 'test_timeout_ms must be a positive number at most 600000' };
    var shards = args.shards == null ? RUN_TESTS_DEFAULT_SHARDS : Number(args.shards);
    if (!Number.isSafeInteger(shards) || shards < 1 || shards > RUN_TESTS_MAX_SHARDS) return { ok: false, error: 'shards must be an integer from 1 to ' + RUN_TESTS_MAX_SHARDS };
    return { ok: true, value: { files: args.files ? args.files.map(function(f) { return f.trim(); }) : null, pattern: args.pattern == null ? null : String(args.pattern), tags: tags, timeout_ms: timeout, test_timeout_ms: testTimeout, shards: shards, allow_tools: allowed, workspace: args.workspace || undefined } };
}

// Default discovery: test/*.test.js from a wsLs entry list (harness.js excluded by suffix).
// wsLs (020-tool-execution.js) DECORATES its entries: dirty files carry a trailing
// " *" (or " * \u26a0 WIP by another ... chat"), dirs read "name/ (N files)" — so the
// bare name is everything before the first whitespace+"*". Without this strip every
// dirty test file (i.e. exactly the ones being worked on) would be silently skipped.
function rtSelectTestFiles(entries, pattern) {
    var files = (entries || []).map(function(n) { return String(n).replace(/\s+\*.*$/, '').trim(); }).filter(function(n) { return /\.test\.js$/.test(n); }).map(function(n) { return n.indexOf('test/') === 0 ? n : 'test/' + n; }).sort();
    if (pattern) { var re = new RegExp(pattern); files = files.filter(function(f) { return re.test(f); }); }
    return files;
}

// The js_eval program. `cfg` is embedded as JSON; everything else runs in the sandbox.
// Per-frame source cache (perf). Profiled 2026-11-09 on the full suite (305 files,
// 4352 tests, 1 shard): 11,879 loadFile round-trips for only 349 distinct paths
// (060-ui-constants.js alone 680x, 020-tool-execution.js 486 KB x 250). Each one
// crossed frame -> host gate -> run_js_file -> workspace read and back, and all
// shard frames share ONE renderer main thread (measured: four 3 s busy-loop files
// on 4 shards ran strictly back-to-back), so those round-trips dominated: 145 s
// -> 65 s with the cache emulated. Installed BEFORE H.install so every wrapper
// (harness i18n, runFile, loadModules) reads through it. Only successful reads
// are kept (a failed or host-denied read is evicted and re-asks the host gate);
// the workspace is read-only for the whole run (host isolation snapshot), and
// the cache dies with this exact frame.
var RT_SOURCE_CACHE_CODE = [
    '(function(w) {',
    '  var orig = w.loadFile, cache = new Map();',
    '  if (typeof orig !== "function") return;',
    '  w.loadFile = function(path, workspace) {',
    '    var k = JSON.stringify([String(path), workspace == null ? null : String(workspace)]);',
    '    if (cache.has(k)) return cache.get(k);',
    '    var p = Promise.resolve(orig.apply(this, arguments));',
    '    cache.set(k, p);',
    '    p.then(function(v) { if (typeof v !== "string") cache.delete(k); }, function() { cache.delete(k); });',
    '    return p;',
    '  };',
    '})(window);'
].join('\n');

function rtBuildSandboxCode(cfg) {
    return [
        'var cfg = ' + JSON.stringify(cfg) + ';',
        RT_SOURCE_CACHE_CODE,
        'var H = await evalModule(cfg.harness_source, cfg.harness, {});',
        'H.install(window);',
        'var guard = H.installToolGuard(window, { workspace: cfg.workspace });',
        'var out = { files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0 }, denied_calls: guard.denied_calls, ran_in: "js_eval-sandbox", unsupported_layers: ["contract", "runtime"] };',
        'for (var i = 0; i < cfg.files.length; i++) {',
        '  var file = cfg.files[i], t0 = Date.now(), entry = { file: file, status: "pass", passed: 0, failed: 0, skipped: 0, failures: [] };',
        '  try { parent.postMessage({ type: "sandboxTestProgress", index: i, file: file, phase: "start" }, "*"); } catch (_) {}',
        '  H.reset(file);',
        '  try {',
        '    await evalModule(cfg.sources[i], file, { workspace: cfg.workspace });',
        '    var r = await H.run({ tags: cfg.tags, timeout_ms: cfg.test_timeout_ms, read_only_host: true, onTimeout: function(info) { var msg = { type: "sandboxTestTimeout", test: info && info.test, file: info && info.file, partial: { files: out.files.slice(), denied_calls: (out.denied_calls || []).slice() } }; try { parent.postMessage(msg, "*"); } catch (_) { var dc; try { dc = JSON.parse(JSON.stringify(out.denied_calls || [])); } catch (_2) { dc = [{ reason: "uncloneable sandbox denial log" }]; } parent.postMessage({ type: "sandboxTestTimeout", test: msg.test, file: msg.file, partial: { denied_calls: dc } }, "*"); } } });',
        '    entry.passed = r.passed; entry.failed = r.failed; entry.skipped = r.skipped; entry.no_assertions = r.no_assertions || 0; entry.tests = r.tests.length;',
        '    entry.skips = r.tests.filter(function(t) { return t.status === "skip"; }).map(function(t) { return { name: t.name, reason: t.reason }; });',
        '    entry.failures = r.tests.filter(function(t) { return t.status === "fail" || t.status === "no_assertions"; }).map(function(t) { return { name: t.name, message: t.error.message, stack: t.error.stack }; });',
        '    entry.aborted = !!r.aborted;',
        '    if (r.failed) entry.status = "fail"; else if (!r.tests.length) entry.status = "empty";',
        '  } catch (e) { entry.status = "error"; entry.error = String(e && e.message || e); }',
        '  entry.duration_ms = Date.now() - t0; out.files.push(entry);',
        '  try { parent.postMessage({ type: "sandboxTestProgress", index: i, file: file, phase: "done", status: entry.status, passed: entry.passed, failed: entry.failed, skipped: entry.skipped }, "*"); } catch (_) {}',
        '  if (entry.aborted) { out.aborted = true; break; }',
        '}',
        'return out;'
    ].join('\n');
}

// Live per-file progress (display only, never authority or verdict). The
// sandbox is untrusted: accept only a known file at its exact index, a known
// phase/status and non-negative integer counts; anything else is dropped.
function rtProgressEvent(raw, cfg) {
    if (!raw || typeof raw !== 'object' || !cfg || !Array.isArray(cfg.files)) return null;
    var i = raw.index;
    if (!Number.isSafeInteger(i) || i < 0 || i >= cfg.files.length || raw.file !== cfg.files[i]) return null;
    var ev = { index: i, file: cfg.files[i], total: cfg.files.length, phase: raw.phase };
    if (raw.phase === 'start') return ev;
    if (raw.phase !== 'done' || ['pass', 'fail', 'error', 'empty'].indexOf(raw.status) < 0) return null;
    if (!['passed', 'failed', 'skipped'].every(function(k) { return Number.isSafeInteger(raw[k]) && raw[k] >= 0; })) return null;
    ev.status = raw.status; ev.passed = raw.passed; ev.failed = raw.failed; ev.skipped = raw.skipped;
    return ev;
}

// Sandbox data cannot erase host denials or isolation findings. Recompute the
// summary and success; do not trust a sandbox-provided success/isolation field.
function rtParseEvalResult(evalRes, cfg, isolation, hostDenials) {
    var envelope = evalRes && evalRes.success === true && evalRes.result;
    if (!envelope || envelope.host_test_boundary !== true || !envelope.value || !Array.isArray(envelope.value.files)) {
        return { success: false, error: 'run_tests: sandbox failed or invalid host envelope: ' + (evalRes && evalRes.error || 'no attested result'), files: [], isolation: isolation, denied_calls: hostDenials || [] };
    }
    var out = envelope.value;
    var invalid = out.files.length !== cfg.files.length || out.files.some(function(f, i) {
        return !f || f.file !== cfg.files[i] || ['pass', 'fail', 'error', 'empty'].indexOf(f.status) < 0 ||
            ['passed', 'failed', 'skipped'].some(function(k) { return !Number.isSafeInteger(f[k]) || f[k] < 0; });
    });
    var denied = rtCombineDenials(hostDenials, envelope.denied_calls, out.denied_calls);
    var summary = { files: out.files.length, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0 };
    if (!invalid) out.files.forEach(function(f) {
        summary.passed += f.passed; summary.failed += f.failed + (f.status === 'error' || f.status === 'empty' ? 1 : 0);
        summary.skipped += f.skipped; summary.no_assertions += f.no_assertions || 0;
    });
    summary.total = summary.passed + summary.failed + summary.skipped;
    var success = !invalid && !out.aborted && summary.failed === 0 && summary.no_assertions === 0 &&
        out.files.every(function(f) { return f.status === 'pass'; }) && isolation && isolation.ok === true && denied.length === 0;
    return { success: !!success, files: out.files, summary: summary, isolation: isolation, denied_calls: denied,
        unsupported_layers: ['contract', 'runtime'], ran_in: 'host-guarded-js_eval-sandbox',
        note: 'Read-only tool boundary; contract/runtime layers unsupported. Direct JavaScript networking is not isolated.',
        error: success ? undefined : (invalid ? 'Invalid/incomplete sandbox result' : 'Test failure, denied tool call or unverified isolation') };
}

// ─── parallel shards (pure helpers) ─────────────────────────────────────────

function rtValidDuration(d) { return typeof d === 'number' && isFinite(d) && d >= 0 && d <= 600000; }
function rtCountTests(src) { var m = String(src || '').match(/\btest(?:\.skip)?\s*\(/g); return m ? m.length : 0; }
function rtValidEntry(f, file) {
    return !!f && f.file === file && ['pass', 'fail', 'error', 'empty'].indexOf(f.status) >= 0 &&
        ['passed', 'failed', 'skipped'].every(function(k) { return Number.isSafeInteger(f[k]) && f[k] >= 0; });
}

// Greedy LPT: heaviest file first into the lightest shard (ties: fewest files).
// weight = recorded duration_ms, else test count x average ms/test. Each shard
// keeps its files in original order. Returns [{indices:[global idx], weight}].
function rtPlanShards(files, sources, durations, n) {
    files = Array.isArray(files) ? files : []; sources = sources || []; durations = durations || {};
    function known(f) { return Object.prototype.hasOwnProperty.call(durations, f) && rtValidDuration(durations[f]); }
    n = Math.max(1, Math.min(Number.isSafeInteger(n) ? n : 1, files.length || 1));
    var ms = 0, tests = 0;
    files.forEach(function(f, i) { var c = rtCountTests(sources[i]); if (known(f) && c > 0) { ms += durations[f]; tests += c; } });
    var avg = tests ? ms / tests : RUN_TESTS_DEFAULT_MS_PER_TEST;
    var weights = files.map(function(f, i) { return Math.max(1, known(f) ? durations[f] : Math.round(rtCountTests(sources[i]) * avg)); });
    var order = files.map(function(_, i) { return i; }).sort(function(a, b) { return (weights[b] - weights[a]) || (a - b); });
    var bins = []; for (var k = 0; k < n; k++) bins.push({ indices: [], weight: 0 });
    order.forEach(function(i) {
        var best = bins[0];
        bins.forEach(function(b) { if (b.weight < best.weight || (b.weight === best.weight && b.indices.length < best.indices.length)) best = b; });
        best.indices.push(i); best.weight += weights[i];
    });
    return bins.filter(function(b) { return b.indices.length; }).map(function(b) { return { indices: b.indices.sort(function(x, y) { return x - y; }), weight: b.weight }; });
}

// Shard-local progress -> global batch index (display only; same sanitizer).
function rtShardProgressEvent(raw, shardCfg, indices, total) {
    var ev = rtProgressEvent(raw, shardCfg);
    if (!ev || !Array.isArray(indices) || !Number.isSafeInteger(indices[ev.index])) return null;
    ev.index = indices[ev.index]; ev.total = total;
    return ev;
}

// Host denials are authoritative. A page-ingress envelope repeats the SAME
// registry denials (runFrame resolves with reg.denials(key)), so an envelope
// entry equal to a not-yet-matched host entry is not counted twice. Sandbox
// guard denials are a separate source and always appended. Deduping can never
// empty a non-empty list (host entries are all kept), so it cannot turn red green.
function rtCombineDenials(hostDenials, envDenials, sandboxDenials) {
    var out = Array.isArray(hostDenials) ? hostDenials.slice() : [], seen = Object.create(null);
    out.forEach(function(d) { var k = JSON.stringify(d); seen[k] = (seen[k] || 0) + 1; });
    (Array.isArray(envDenials) ? envDenials : []).forEach(function(d) {
        var k = JSON.stringify(d);
        if (seen[k] > 0) seen[k]--; else out.push(d);
    });
    return out.concat(Array.isArray(sandboxDenials) ? sandboxDenials : []);
}

// A failure before any shard was dispatched (baseline/snapshot, source read,
// context open, cancel...). Keeps the full envelope shape (files + summary) so
// consumers such as the Reload dialog show the real cause instead of a
// "malformed result"; always fails (0 tests ran).
function rtFailedRunResult(error, code, isolation, denied) {
    return { success: false, error: String(error || 'run_tests failed before any test ran'), error_code: code || 'PRE_DISPATCH_FAILED', tests_ran: 0,
        files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0, aborted: 0, not_run: 0 },
        isolation: isolation || { ok: false, error: 'Not verified: no test ran' }, denied_calls: Array.isArray(denied) ? denied : [],
        unsupported_layers: ['contract', 'runtime'], ran_in: 'host-guarded-js_eval-sandbox' };
}

function rtNotRun(file, why) { return { file: file, status: 'not_run', passed: 0, failed: 0, skipped: 0, no_assertions: 0, failures: [], error: why }; }

// A shard whose js_eval never produced a verdict because the CHANNEL died: the
// offscreen document / sandbox frame was closed under it ("message channel
// closed", "message port closed", "Receiving end does not exist", "Could not
// establish connection") or no reply came back at all. Only these are
// SANDBOX_TRANSPORT. A success:true result without an envelope, the js_eval
// 5-minute inactivity timeout, a cancel/deadline and OFFSCREEN_* startup codes
// keep their own labels and are never retried.
var RT_TRANSPORT_RE = /message channel closed|message port closed|Receiving end does not exist|Could not establish connection|returned no response|no response was received/i;
function rtIsTransportFailure(evalRes) {
    if (!evalRes) return true;
    if (evalRes.success !== false) return false;
    var msg = String(evalRes.error || '');
    if (/timed out after|inactivity|cancelled|canceled|Per-test timeout|\bOFFSCREEN_[A-Z_]+\b/i.test(msg)) return false;
    return RT_TRANSPORT_RE.test(msg);
}

// Merge per-shard js_eval results. shardRuns: [{indices, evalRes, duration_ms}].
// Host denials/isolation are authoritative; sandbox data can only ADD failures.
// A timed-out shard keeps its completed prefix; the timed-out file is aborted
// (counted failed, test named) and the rest of that shard is not_run. A shard
// with no valid envelope marks all its files not_run. If NO shard produced a
// valid envelope the result keeps the legacy shape (files: []).
function rtMergeShardResults(shardRuns, cfg, isolation, hostDenials) {
    var all = cfg && Array.isArray(cfg.files) ? cfg.files : [], N = shardRuns.length;
    var slots = new Array(all.length), denied = (hostDenials || []).slice();
    var shards = [], timeouts = [], errors = [], anyValid = false, firstErr = null, firstFailed = null;
    shardRuns.forEach(function(s, k) {
        var label = '(shard ' + (k + 1) + '/' + N + ')';
        var sf = s.indices.map(function(i) { return all[i]; });
        var evalRes = s.evalRes, env = evalRes && evalRes.success === true && evalRes.result;
        var info = { index: k, file_count: sf.length, duration_ms: s.duration_ms || 0, status: 'ok' };
        // One automatic re-run after a SANDBOX_TRANSPORT loss (executeRunTests).
        if (s.transport_retries) { info.transport_retries = s.transport_retries; if (s.first_error) info.first_error = String(s.first_error).slice(0, 500); }
        shards.push(info);
        var reason = null, transport = false;
        if (env && env.host_test_boundary === true && env.value && Array.isArray(env.value.files)) {
            // An envelope only repeats ITS OWN shard's registry denials: dedupe against
            // that shard's host log (all host entries are already in `denied`).
            if (Array.isArray(s.hostDenials)) denied = denied.concat(rtCombineDenials(s.hostDenials, env.denied_calls, env.value.denied_calls).slice(s.hostDenials.length));
            else denied = rtCombineDenials(denied, env.denied_calls, env.value.denied_calls);
            var v = env.value, got = v.files;
            var to = v.aborted === true && v.timed_out && typeof v.timed_out === 'object' ? v.timed_out : null;
            if (to) {
                var at = got.length;
                // The partial must be a valid prefix and, when named, the timed-out
                // file must be the next one in this shard (else fail closed below).
                var namedOk = typeof to.file === 'string' && !!to.file && to.file === sf[at];
                if (at < sf.length && namedOk && got.every(function(f, i) { return rtValidEntry(f, sf[i]); })) {
                    var test = typeof to.test === 'string' && to.test ? to.test.slice(0, 500) : '(unknown test)';
                    got.forEach(function(f, i) { slots[s.indices[i]] = f; });
                    slots[s.indices[at]] = { file: sf[at], status: 'aborted', aborted: true, passed: 0, failed: 1, skipped: 0, no_assertions: 0, failures: [{ name: test, message: 'Per-test timeout' }], error: 'Per-test timeout: ' + test };
                    for (var j = at + 1; j < sf.length; j++) slots[s.indices[j]] = rtNotRun(sf[j], 'Not run: shard aborted after per-test timeout in ' + sf[at] + ' ' + label);
                    info.status = 'timed_out'; info.error = 'Per-test timeout in ' + sf[at] + ' \u203a ' + test + ' ' + label;
                    timeouts.push(info.error); anyValid = true;
                    return;
                }
                reason = 'Invalid partial result after per-test timeout';
            } else if (got.length === sf.length && got.every(function(f, i) { return rtValidEntry(f, sf[i]); })) {
                got.forEach(function(f, i) { slots[s.indices[i]] = f; });
                anyValid = true;
                if (v.aborted) { info.status = 'aborted'; info.error = 'Sandbox reported an aborted run ' + label; errors.push(info.error); }
                return;
            } else reason = 'Invalid/incomplete sandbox result';
        } else { reason = evalRes && evalRes.error || 'no attested result'; transport = rtIsTransportFailure(evalRes); }
        if (!firstFailed && evalRes && evalRes.success === false) firstFailed = evalRes;
        if (firstErr === null) firstErr = String(reason);
        info.status = 'error'; info.error = String(reason).slice(0, 2000);
        // No envelope at all = the shard's transport died (sandbox frame / offscreen
        // document / message channel), not a test verdict: say so distinctly.
        if (transport) info.error_code = 'SANDBOX_TRANSPORT';
        sf.forEach(function(f, i) {
            var row = rtNotRun(f, 'Not run: ' + info.error + ' ' + label);
            // Per-file rows carry the shard's transport code (Reload dialog: no verdict).
            if (transport) row.error_code = 'SANDBOX_TRANSPORT';
            slots[s.indices[i]] = row;
        });
        errors.push((transport ? 'Sandbox transport failure (no test verdict) ' : 'Invalid/incomplete sandbox result ') + label + ': ' + info.error);
    });
    for (var h = 0; h < slots.length; h++) if (!slots[h]) slots[h] = rtNotRun(all[h], 'Not run: not assigned to any shard');
    var files = anyValid ? slots : [];
    var summary = { files: files.length, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0, aborted: 0, not_run: 0 };
    files.forEach(function(f) {
        if (f.status === 'not_run') { summary.not_run++; return; }
        if (f.status === 'aborted') summary.aborted++;
        summary.passed += f.passed; summary.failed += f.failed + (f.status === 'error' || f.status === 'empty' ? 1 : 0);
        summary.skipped += f.skipped; summary.no_assertions += f.no_assertions || 0;
    });
    summary.total = summary.passed + summary.failed + summary.skipped;
    var isoOk = !!(isolation && isolation.ok === true);
    var success = anyValid && N > 0 && shards.every(function(i) { return i.status === 'ok'; }) && summary.aborted === 0 && summary.not_run === 0 &&
        summary.failed === 0 && summary.no_assertions === 0 && files.every(function(f) { return f.status === 'pass'; }) && isoOk && denied.length === 0;
    var parts = anyValid ? timeouts.concat(errors) : ['run_tests: sandbox failed or invalid host envelope: ' + (firstErr || 'no attested result')];
    if (parts.length && (!isoOk || denied.length)) parts.push('denied tool call or unverified isolation');
    var out = { success: !!success, files: files, summary: summary, isolation: isolation, denied_calls: denied, shards: shards,
        unsupported_layers: ['contract', 'runtime'], ran_in: 'host-guarded-js_eval-sandbox',
        note: 'Read-only tool boundary; contract/runtime layers unsupported. Direct JavaScript networking is not isolated.',
        error: success ? undefined : (parts.length ? parts.join('; ') : 'Test failure, denied tool call or unverified isolation') };
    if (summary.aborted || shards.some(function(i) { return i.status === 'aborted'; })) out.aborted = true;
    // rtGuardResult only sees an eval error when EVERY shard failed.
    out._guardEvalRes = anyValid ? null : firstFailed;
    return out;
}

// Recorded per-file durations (scheduling hint only, never a verdict). In-memory
// only (no new storage write site); the first run per session balances by test count.
var _rtDurations = null;
async function rtLoadDurations() {
    if (!_rtDurations) _rtDurations = Object.create(null);
    return _rtDurations;
}
function rtRecordDurations(files) {
    if (!_rtDurations) _rtDurations = Object.create(null);
    (files || []).forEach(function(f) {
        if (f && ['pass', 'fail', 'empty', 'error'].indexOf(f.status) >= 0 && RUN_TESTS_FILE_RE.test(f.file) && rtValidDuration(f.duration_ms)) _rtDurations[f.file] = f.duration_ms;
    });
}

// B2 coded-error contract (SW side: background.js): offscreen failures read
// 'OFFSCREEN_<CODE>: sentence' and/or keep the /not available/ wording.
var RT_SANDBOX_HINT = 'Hint: Reload the extension; if the problem persists, check chrome://extensions \u2192 AppAgent \u2192 Errors.';
function rtSandboxErrorCode(message, existing) {
    var msg = String(message || ''), m = msg.match(/\bOFFSCREEN_[A-Z_]+\b/);
    if (m) return m[0];
    if (/not available/i.test(msg) && /offscreen|sandbox/i.test(msg)) return 'OFFSCREEN_UNAVAILABLE';
    return existing || null;
}

// Never a silent/empty green: surfaces sandbox errors and fails loudly when no
// test body executed (passed + failed === 0; skips never count). Mutates `out`.
function rtGuardResult(out, cfg, evalRes) {
    var selected = (cfg && Array.isArray(cfg.files) ? cfg.files : []).length;
    var nFiles = selected + ' test file' + (selected === 1 ? '' : 's') + ' selected';
    var files = Array.isArray(out.files) ? out.files : [];
    var ran = files.reduce(function(n, f) { return n + ((f && Number(f.passed)) || 0) + ((f && Number(f.failed)) || 0); }, 0);
    var evalErr = evalRes && evalRes.success === false ? String(evalRes.error || 'js_eval failed without an error message') : '';
    var code = evalErr ? rtSandboxErrorCode(evalErr, evalRes.error_code) : null;
    if (code && /^OFFSCREEN_/.test(code)) {
        var orig = evalErr.replace(/^js_eval sandbox unavailable: /, '').replace(/\s*Hint: Reload the extension[^\n]*$/, '');
        out.success = false; out.error_code = code; out.tests_ran = 0;
        out.error = 'run_tests could not start the sandbox: ' + orig + ' (0 tests ran; ' + nFiles + ').\n' + RT_SANDBOX_HINT;
        return out;
    }
    if (ran > 0) return out;
    var why;
    if (!files.length) why = nFiles + ', but the sandbox returned no file results';
    else {
        var errored = files.filter(function(f) { return f && f.status === 'error'; });
        var empty = files.filter(function(f) { return f && f.status === 'empty'; }).length;
        var skipped = files.reduce(function(n, f) { return n + ((f && Number(f.skipped)) || 0); }, 0);
        why = nFiles + ', ' + (files.length - errored.length) + ' loaded but no test ran (' + empty + ' file' + (empty === 1 ? '' : 's') + ' registered no tests, ' + skipped + ' test' + (skipped === 1 ? '' : 's') + ' skipped' +
            (errored.length ? '; ' + errored.length + ' failed to load, first: ' + errored[0].file + ': ' + errored[0].error : '') + ')';
    }
    out.success = false; out.error_code = 'NO_TESTS_RAN'; out.tests_ran = 0;
    out.error = 'NO_TESTS_RAN: 0 tests ran \u2014 ' + why + '.' + (out.error ? ' ' + out.error : '');
    return out;
}

// ─── page → SW delegation (Reload pre-check) ─────────────────────────────────
// The page's hidden sandbox iframes are timer-throttled when the panel is in the
// background; the SW runs the same guarded executeRunTests with its frames in the
// (unthrottled) offscreen document. All authority (registry contexts, snapshots,
// revocation, denial log) stays in the SW; the page only relays args, re-sanitized
// display progress, cancel, and the final verdict. Fail-closed: a lost/late reply
// is a failure; only a request that never left the page falls back to local.
var _rtWorkerRuns = Object.create(null);
// Bus port lost (SW evicted/restarted): every run posted on it fails closed NOW
// (WORKER_DISCONNECTED) instead of waiting out timeout_ms + 30s. No port = all runs.
function rtWorkerPortLost(port) {
    Object.keys(_rtWorkerRuns).forEach(function(id) {
        var run = _rtWorkerRuns[id];
        if (run && (!port || run.port === port)) run.fail(rtFailedRunResult('run_tests: the service-worker connection was lost before the result arrived (SW restarted or evicted)', 'WORKER_DISCONNECTED'));
    });
}
// Display-only progress relayed by the SW (global batch index/total). With an
// explicit, unfiltered file list the event must match it exactly; otherwise only a
// well-formed test path at an in-range index is accepted. Never authority/verdict.
function rtWorkerProgressEvent(raw, files) {
    if (!raw || typeof raw !== 'object') return null;
    var list = files;
    if (!list) {
        var n = raw.total, i = raw.index;
        if (!Number.isSafeInteger(n) || n < 1 || n > 10000 || !Number.isSafeInteger(i) || i < 0 || i >= n || typeof raw.file !== 'string' || !RUN_TESTS_FILE_RE.test(raw.file)) return null;
        list = new Array(n); list[i] = raw.file;
    }
    var ev = rtProgressEvent(raw, { files: list });
    if (ev && Number.isSafeInteger(raw.shard) && raw.shard >= 0) ev.shard = raw.shard;
    return ev;
}
// The SW verdict must keep the run_tests envelope shape; anything else fails closed.
function rtWorkerResult(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || r._rtFallback) return rtFailedRunResult('run_tests: the service worker returned no result', 'WORKER_NO_RESULT');
    if (typeof r.success === 'boolean' && Array.isArray(r.files) && r.summary && typeof r.summary === 'object' && !Array.isArray(r.summary)) return r;
    if (r.success === false) return rtFailedRunResult(typeof r.error === 'string' && r.error ? r.error : 'run_tests failed in the service worker', typeof r.error_code === 'string' && r.error_code ? r.error_code : 'WORKER_ERROR');
    return rtFailedRunResult('run_tests: the service worker returned a malformed result', 'WORKER_BAD_RESULT');
}
function rtWorkerPort() {
    if (typeof Platform !== 'undefined' && Platform && Platform.isWorker) return null;
    if (typeof _agentBusPort === 'undefined' || !_agentBusPort || typeof _agentBusPort.postMessage !== 'function') return null;
    return _agentBusPort;
}
function rtRunViaWorker(port, args, options, timeoutMs) {
    var hostSignal = options && options._runTestsAbortSignal;
    var onProgress = options && typeof options._runTestsOnProgress === 'function' ? options._runTestsOnProgress : null;
    // A pattern filters an explicit list SW-side, so its indices no longer match args.files.
    var files = args && Array.isArray(args.files) && !args.pattern ? args.files.map(function(f) { return String(f).trim(); }) : null;
    var requestId = 'rtw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    return new Promise(function(resolve) {
        var timer = null;
        function done(result) {
            if (!_rtWorkerRuns[requestId]) return;
            delete _rtWorkerRuns[requestId];
            clearTimeout(timer);
            if (hostSignal) hostSignal.removeEventListener('abort', onAbort);
            resolve(result);
        }
        function cancelRemote() { try { port.postMessage({ type: 'run-tests-cancel', requestId: requestId }); } catch (e) { /* SW gone: its own deadline revokes */ } }
        function onAbort() { cancelRemote(); done(rtFailedRunResult('run_tests cancelled', 'CANCELLED')); }
        _rtWorkerRuns[requestId] = {
            port: port,
            progress: function(raw) {
                if (!onProgress) return;
                var ev = rtWorkerProgressEvent(raw, files);
                if (!ev) return;
                try { onProgress(ev); } catch (e) { /* display only */ }
            },
            result: function(r) { done(rtWorkerResult(r)); },
            fail: function(r) { done(r); }
        };
        timer = setTimeout(function() {
            cancelRemote();
            done(rtFailedRunResult('run_tests: no result from the service worker within ' + Math.round((timeoutMs + 30000) / 1000) + 's (port lost or SW restarted)', 'WORKER_TIMEOUT'));
        }, timeoutMs + 30000);
        if (hostSignal) {
            if (hostSignal.aborted) { onAbort(); return; }
            hostSignal.addEventListener('abort', onAbort, { once: true });
        }
        // No chatId/options travel: the SW builds every host option itself.
        try { port.postMessage({ type: 'run-tests-exec', requestId: requestId, args: args }); }
        catch (e) { done({ _rtFallback: true, error: String(e && e.message || e) }); }
    });
}
// Page bus: {type:'run-tests-progress'|'run-tests-result', requestId, ...} from the SW.
function rtHandleWorkerMessage(msg) {
    var run = msg && typeof msg.requestId === 'string' ? _rtWorkerRuns[msg.requestId] : null;
    if (!run) return;
    if (msg.type === 'run-tests-progress') run.progress(msg.event);
    else if (msg.type === 'run-tests-result') run.result(msg.result);
}
// SW side: run the page's request with host-built options (never page-supplied:
// msg.options/msg.chatId/_runTestsLocal are ignored; SW-served runs are chat-less).
// Runs are keyed by requesting port + id: only that port can cancel them, and its
// disconnect aborts them (abort revokes every shard context in executeRunTests).
var _rtWorkerHostRuns = new Map();
function rtServeWorkerRequest(port, msg) {
    var id = msg && typeof msg.requestId === 'string' && msg.requestId && msg.requestId.length <= 200 ? msg.requestId : null;
    if (!port || typeof port.postMessage !== 'function' || !id) return;
    function post(m) { try { port.postMessage(m); } catch (e) { /* page gone: its disconnect/timer fails closed */ } }
    var runs = _rtWorkerHostRuns.get(port);
    if (!runs) { runs = Object.create(null); _rtWorkerHostRuns.set(port, runs); }
    if (runs[id]) {
        // A reused id is a page bug or forgery: the page-side run now resolves with this
        // explicit failure, so the earlier SW run is orphaned and is aborted too.
        runs[id].abort();
        post({ type: 'run-tests-result', requestId: id, result: rtFailedRunResult('run_tests: duplicate requestId ' + id + ' (the earlier run with this id was cancelled)', 'DUPLICATE_REQUEST') });
        return;
    }
    var ctrl = new AbortController();
    runs[id] = ctrl;
    var opts = { _runTestsLocal: true, _runTestsAbortSignal: ctrl.signal, _runTestsOnProgress: function(ev) { if (!ctrl.signal.aborted) post({ type: 'run-tests-progress', requestId: id, event: ev }); } };
    Promise.resolve().then(function() { return executeRunTests(msg.args, null, opts); })
        .catch(function(e) { return rtFailedRunResult('run_tests failed in the service worker: ' + String(e && e.message || e), 'WORKER_ERROR'); })
        .then(function(r) {
            if (runs[id] === ctrl) delete runs[id];
            if (_rtWorkerHostRuns.get(port) === runs && !Object.keys(runs).length) _rtWorkerHostRuns.delete(port);
            post({ type: 'run-tests-result', requestId: id, result: r });
        });
}
function rtCancelWorkerRequest(port, msg) {
    var runs = port ? _rtWorkerHostRuns.get(port) : null;
    var c = runs && msg && typeof msg.requestId === 'string' ? runs[msg.requestId] : null;
    if (c) c.abort();
}
// SW side: the requesting port disconnected; abort (and so revoke) all its runs.
function rtWorkerHostPortClosed(port) {
    var runs = _rtWorkerHostRuns.get(port);
    if (!runs) return;
    _rtWorkerHostRuns.delete(port);
    Object.keys(runs).forEach(function(id) { runs[id].abort(); });
}
function rtWorkerRunCounts() {
    var host = 0;
    _rtWorkerHostRuns.forEach(function(runs) { host += Object.keys(runs).length; });
    return { page: Object.keys(_rtWorkerRuns).length, host: host, host_ports: _rtWorkerHostRuns.size };
}

var RunTestsHelpers = { rtCombineDenials: rtCombineDenials, rtFailedRunResult: rtFailedRunResult, rtRunViaWorker: rtRunViaWorker, rtHandleWorkerMessage: rtHandleWorkerMessage, rtServeWorkerRequest: rtServeWorkerRequest, rtCancelWorkerRequest: rtCancelWorkerRequest, rtWorkerPortLost: rtWorkerPortLost, rtWorkerHostPortClosed: rtWorkerHostPortClosed, rtWorkerRunCounts: rtWorkerRunCounts, rtWorkerProgressEvent: rtWorkerProgressEvent, rjfValidateArgs: rjfValidateArgs, rtValidateArgs: rtValidateArgs, rtSelectTestFiles: rtSelectTestFiles, rtBuildSandboxCode: rtBuildSandboxCode, rtProgressEvent: rtProgressEvent, rtParseEvalResult: rtParseEvalResult, rtDevModeActive: rtDevModeActive, RUN_TESTS_FILE_RE: RUN_TESTS_FILE_RE, rtSandboxErrorCode: rtSandboxErrorCode, rtGuardResult: rtGuardResult, rtPlanShards: rtPlanShards, rtShardProgressEvent: rtShardProgressEvent, rtMergeShardResults: rtMergeShardResults, rtCountTests: rtCountTests, rtIsTransportFailure: rtIsTransportFailure };

// ─── tool entry points (dispatched from tools/020-tool-execution.js) ─────────

function _rtEvalOptions(options) {
    var o = {};
    if (options && options.chatId) o.chatId = options.chatId;
    if (options && options.toolCallId) { o.toolCallId = options.toolCallId; o.parentToolCallId = options.toolCallId; }
    if (options && options.fromSandbox) o.fromSandbox = true;
    return o;
}

async function executeRunJsFile(args, messageIndex, options) {
    var v = rjfValidateArgs(args);
    if (!v.ok) return { success: false, error: v.error };
    var a = v.value;
    var wk = await resolveWorkspace(a.workspace);
    if (wk && wk.error) return { success: false, error: wk.error };
    if (a.mode === 'source') {
        var raw = await wsReadRaw(wk, a.path);
        if (!raw.success) return raw;
        return { success: true, path: a.path, workspace: wk, content: raw.file.content, size: raw.file.content.length, dirty: !!raw.file.dirty };
    }
    var code;
    if (a.mode === 'script') {
        var rawS = await wsReadRaw(wk, a.path);
        if (!rawS.success) return rawS;
        code = rawS.file.content;
    } else {
        code = 'return await runFile(' + JSON.stringify(a.path) + ', ' + JSON.stringify(a.args) + ', ' + JSON.stringify(wk) + ');';
    }
    var res = await executeTool('js_eval', { code: code }, messageIndex, _rtEvalOptions(options));
    if (!res || res.success === false) return { success: false, path: a.path, mode: a.mode, error: (res && res.error) || 'js_eval failed', error_code: (res && res.error_code) || undefined };
    return { success: true, path: a.path, mode: a.mode, workspace: wk, result: res.result };
}

async function executeRunTests(args, messageIndex, options) {
    if (options && options.fromSandbox) return { success: false, error: 'run_tests must be a top-level caller; nested execution cannot grant authority' };
    // Native page cancellation is host-options-only; model args cannot supply it.
    var hostSignal = options && options._runTestsAbortSignal;
    if (hostSignal && hostSignal.aborted) return rtFailedRunResult('run_tests cancelled before dispatch', 'CANCELLED');
    var v = rtValidateArgs(args);
    if (!v.ok) return { success: false, error: v.error };
    // Page ingress (Reload pre-check, widgets): run in the SW, whose sandbox frames
    // live in the offscreen document (hidden panel iframes are timer-throttled).
    var workerPort = options && options._runTestsLocal ? null : rtWorkerPort();
    if (workerPort) {
        var delegated = await rtRunViaWorker(workerPort, args, options, v.value.timeout_ms);
        if (!delegated || !delegated._rtFallback) return delegated;
        // The request never reached the SW: fall back to the (guarded, fail-closed) local path.
        if (hostSignal && hostSignal.aborted) return rtFailedRunResult('run_tests cancelled before dispatch', 'CANCELLED');
    }
    var a = v.value, started = Date.now(), deadline = started + a.timeout_ms, runNonce = Math.random().toString(36).slice(2, 10);
    var contexts = [], controller = new AbortController(), wk, cfg, before, isolation, shardRuns = [];
    // Cancel revokes EVERY shard context (and aborts every exact frame).
    function cancel() { contexts.forEach(function(c) { TestRunPolicy.registry.revoke(c); }); controller.abort(); }
    function active() { if (controller.signal.aborted) throw new Error('run_tests cancelled'); }
    async function budget(p) {
        // A synchronous callback can abort while creating p; still observe a
        // later rejection even though no new authority may be dispatched.
        p = Promise.resolve(p); p.catch(function() {});
        active();
        var onAbort;
        var aborted = new Promise(function(_, reject) {
            onAbort = function() { reject(new Error('run_tests cancelled')); };
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try { var value = await TestRunPolicy.bounded(Promise.race([p, aborted]), deadline - Date.now(), cancel); active(); return value; }
        finally { controller.signal.removeEventListener('abort', onAbort); }
    }
    if (hostSignal) hostSignal.addEventListener('abort', cancel, { once: true });
    async function snapshot(until) {
        function active() {
            if (!before && controller.signal.aborted) throw new Error('Host baseline cancelled');
            if (Date.now() >= until) throw new Error('Host snapshot budget expired');
        }
        return TestRunPolicy.snapshot(
            function() { active(); return wsStatus(wk, true, options && options.chatId); },
            async function(path) {
                active();
                var r = await wsReadRaw(wk, path);
                if (!r || r.success !== true || r.capped || r.truncated || r._cached || r._more || !r.file || r.file.capped || r.file.truncated || typeof r.file.content !== 'string') throw new Error('Host isolation read failed or capped: ' + path);
                return { success: true, content: r.file.content };
            },
            async function(content) { active(); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))).map(function(n) { return n.toString(16).padStart(2, '0'); }).join(''); }, 500);
    }
    var evalRes;
    try {
        active();
        wk = await budget(resolveWorkspace(a.workspace));
        if (typeof wk !== 'string' || !wk) throw new Error(wk && wk.error || 'No selected workspace');
        var files = a.files;
        if (!files) {
            var ls = await budget(wsLs(wk, 'test', false, options && options.chatId));
            if (!ls || ls.success !== true || !Array.isArray(ls.entries)) throw new Error('Cannot list test/');
            files = rtSelectTestFiles(ls.entries, a.pattern);
        } else if (a.pattern) { var re = new RegExp(a.pattern); files = files.filter(function(f) { return re.test(f); }); }
        if (!files.every(function(f) { return TestRunPolicy.canonical(f) && RUN_TESTS_FILE_RE.test(f); })) throw new Error('Invalid test source path');
        // Zero matched files is a FAILURE, not a green run: a typo'd pattern must
        // never read as "all tests passed" (no matched files == nothing verified).
        if (!files.length) {
            var _noMatch = 'NO_TESTS_MATCHED: no test files matched' +
                (a.pattern ? ' pattern ' + JSON.stringify(String(a.pattern)) : '') +
                (Array.isArray(a.files) ? ' in files ' + JSON.stringify(a.files) : ' in test/') + '.' +
                ' NO_TESTS_RAN: 0 test files selected, so 0 tests ran.';
            return { success: false, error: _noMatch, code: 'NO_TESTS_MATCHED', error_code: 'NO_TESTS_RAN', tests_ran: 0, pattern: a.pattern || null, files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0 } };
        }
        // Complete baseline before loading any executable test code. Any failed or
        // capped snapshot aborts BEFORE dispatch; snapshots never go through tests.
        before = await budget(snapshot(deadline));
        async function source(path) {
            active();
            var r = await budget(wsReadRaw(wk, path));
            if (!r || r.success !== true || r.capped || r.truncated || r._cached || r._more || !r.file || r.file.capped || r.file.truncated || typeof r.file.content !== 'string') throw new Error('Cannot read complete source: ' + path);
            return r.file.content;
        }
        cfg = { files: files.slice(), sources: [], harness_source: await source(RUN_TESTS_HARNESS_PATH), tags: a.tags, test_timeout_ms: a.test_timeout_ms, workspace: wk, harness: RUN_TESTS_HARNESS_PATH };
        for (var file of files) cfg.sources.push(await source(file));
        active();
        var plan = rtPlanShards(cfg.files, cfg.sources, await rtLoadDurations(), a.shards);
        active();
        // Host-only live progress hook (e.g. the Reload checklist); model args cannot supply it.
        var onProgress = options && typeof options._runTestsOnProgress === 'function' ? options._runTestsOnProgress : null;
        var jobs = plan.map(function(p, k) {
            var shardCfg = { files: p.indices.map(function(i) { return cfg.files[i]; }), sources: p.indices.map(function(i) { return cfg.sources[i]; }), harness_source: cfg.harness_source, tags: cfg.tags, test_timeout_ms: cfg.test_timeout_ms, workspace: wk, harness: cfg.harness };
            // One registry context (own authority + denial log) per shard frame.
            var ctx = TestRunPolicy.registry.open({ workspace: wk, deadline: deadline, allow_tools: a.allow_tools });
            contexts.push(ctx);
            var evalOptions = _rtEvalOptions(options);
            // Sandbox call ids restart at 1 per frame: keep inner tool-call ids unique.
            // Without a host toolCallId every shard still gets its own base id.
            if (!evalOptions.toolCallId) evalOptions.toolCallId = 'run_tests_' + started + '_' + runNonce + '_s' + k;
            else if (k > 0) evalOptions.toolCallId = evalOptions.toolCallId + '_s' + k;
            evalOptions._testRunContext = ctx;
            evalOptions._testRunSignal = controller.signal;
            if (onProgress) evalOptions._testRunOnProgress = function(raw) {
                if (controller.signal.aborted) return;
                var ev = rtShardProgressEvent(raw, shardCfg, p.indices, cfg.files.length);
                if (ev) { ev.shard = k; try { onProgress(ev); } catch (e) { /* display only */ } }
            };
            var run = { indices: p.indices, evalRes: null, duration_ms: 0, ctx: ctx };
            shardRuns.push(run);
            return { code: rtBuildSandboxCode(shardCfg), options: evalOptions, run: run };
        });
        active();
        function runJob(j) {
            var t0 = Date.now();
            return budget(executeTool('js_eval', { code: j.code }, messageIndex, j.options))
                .then(function(r) { j.run.evalRes = r; }, function(e) { j.run.evalRes = { success: false, error: String(e && e.message || e) }; })
                .then(function() { j.run.duration_ms += Date.now() - t0; });
        }
        await Promise.all(jobs.map(function(j) {
            return runJob(j).then(function() {
                // A forced offscreen close (wedged-document recreate, zombie heal,
                // js_eval watchdog) kills sibling shards with no verdict. Re-run
                // such a shard ONCE in a fresh sandbox + registry context. Never
                // real failures, aborts, per-test or inactivity timeouts, cancel.
                if (!rtIsTransportFailure(j.run.evalRes) || controller.signal.aborted || Date.now() >= deadline) return;
                j.run.transport_retries = 1;
                j.run.first_error = j.run.evalRes && j.run.evalRes.error || 'no reply';
                var ctx2 = TestRunPolicy.registry.open({ workspace: wk, deadline: deadline, allow_tools: a.allow_tools });
                contexts.push(ctx2);
                j.run.ctx = ctx2;
                j.options = Object.assign({}, j.options, { _testRunContext: ctx2, toolCallId: j.options.toolCallId + '_r1' });
                return runJob(j);
            });
        }));
    } catch (error) {
        evalRes = { success: false, error: String(error && error.message || error) };
    } finally {
        cancel();
        if (hostSignal) hostSignal.removeEventListener('abort', cancel);
    }
    if (!before) {
        var baseOut = rtFailedRunResult('run_tests failed before any test ran (host isolation baseline): ' + (evalRes && evalRes.error || 'Host baseline failed'), 'PRE_DISPATCH_FAILED', { ok: false, error: 'Baseline unavailable' });
        baseOut.duration_ms = Date.now() - started; baseOut.workspace = wk;
        return baseOut;
    }
    try {
        // Independent cleanup budget. Never reopen test authority or mutate scratch.
        var after = await TestRunPolicy.bounded(snapshot(Date.now() + 10000), 10000);
        isolation = TestRunPolicy.compare(before, after);
    } catch (error) { isolation = { ok: false, error: String(error && error.message || error), violations: [] }; }
    var hostDenials = [];
    contexts.forEach(function(c) { hostDenials = hostDenials.concat(TestRunPolicy.registry.denials(c)); });
    var out;
    if (!shardRuns.length) {
        // Nothing was dispatched (throw while reading sources/opening contexts):
        // a readable, failing envelope instead of a shapeless sandbox error.
        out = rtFailedRunResult('run_tests failed before any test ran: ' + (evalRes && evalRes.error || 'no shard was dispatched'), 'PRE_DISPATCH_FAILED', isolation, hostDenials);
    } else {
        shardRuns.forEach(function(r) {
            if (!r.evalRes) r.evalRes = evalRes || { success: false, error: 'shard not dispatched' };
            r.hostDenials = TestRunPolicy.registry.denials(r.ctx);
        });
        out = rtMergeShardResults(shardRuns, cfg, isolation, hostDenials);
        var guardEval = out._guardEvalRes; delete out._guardEvalRes;
        rtGuardResult(out, cfg, guardEval);
        rtRecordDurations(out.files);
    }
    out.duration_ms = Date.now() - started;
    out.workspace = wk;
    return out;
}
