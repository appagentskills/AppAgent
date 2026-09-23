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
    return { ok: true, value: { files: args.files ? args.files.map(function(f) { return f.trim(); }) : null, pattern: args.pattern == null ? null : String(args.pattern), tags: tags, timeout_ms: timeout, test_timeout_ms: testTimeout, allow_tools: allowed, workspace: args.workspace || undefined } };
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
function rtBuildSandboxCode(cfg) {
    return [
        'var cfg = ' + JSON.stringify(cfg) + ';',
        'var H = await evalModule(cfg.harness_source, cfg.harness, {});',
        'H.install(window);',
        'var guard = H.installToolGuard(window, { workspace: cfg.workspace });',
        'var out = { files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0, no_assertions: 0 }, denied_calls: guard.denied_calls, ran_in: "js_eval-sandbox", unsupported_layers: ["contract", "runtime"] };',
        'for (var i = 0; i < cfg.files.length; i++) {',
        '  var file = cfg.files[i], t0 = Date.now(), entry = { file: file, status: "pass", passed: 0, failed: 0, skipped: 0, failures: [] };',
        '  H.reset(file);',
        '  try {',
        '    await evalModule(cfg.sources[i], file, { workspace: cfg.workspace });',
        '    var r = await H.run({ tags: cfg.tags, timeout_ms: cfg.test_timeout_ms, read_only_host: true, onTimeout: function() { parent.postMessage({ type: "sandboxTestTimeout" }, "*"); } });',
        '    entry.passed = r.passed; entry.failed = r.failed; entry.skipped = r.skipped; entry.no_assertions = r.no_assertions || 0; entry.tests = r.tests.length;',
        '    entry.skips = r.tests.filter(function(t) { return t.status === "skip"; }).map(function(t) { return { name: t.name, reason: t.reason }; });',
        '    entry.failures = r.tests.filter(function(t) { return t.status === "fail" || t.status === "no_assertions"; }).map(function(t) { return { name: t.name, message: t.error.message, stack: t.error.stack }; });',
        '    entry.aborted = !!r.aborted;',
        '    if (r.failed) entry.status = "fail"; else if (!r.tests.length) entry.status = "empty";',
        '  } catch (e) { entry.status = "error"; entry.error = String(e && e.message || e); }',
        '  entry.duration_ms = Date.now() - t0; out.files.push(entry);',
        '  if (entry.aborted) { out.aborted = true; break; }',
        '}',
        'return out;'
    ].join('\n');
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
    var denied = (hostDenials || []).concat(envelope.denied_calls || [], Array.isArray(out.denied_calls) ? out.denied_calls : []);
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

var RunTestsHelpers = { rjfValidateArgs: rjfValidateArgs, rtValidateArgs: rtValidateArgs, rtSelectTestFiles: rtSelectTestFiles, rtBuildSandboxCode: rtBuildSandboxCode, rtParseEvalResult: rtParseEvalResult, rtDevModeActive: rtDevModeActive, RUN_TESTS_FILE_RE: RUN_TESTS_FILE_RE };

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
    if (!res || res.success === false) return { success: false, path: a.path, mode: a.mode, error: (res && res.error) || 'js_eval failed' };
    return { success: true, path: a.path, mode: a.mode, workspace: wk, result: res.result };
}

async function executeRunTests(args, messageIndex, options) {
    if (options && options.fromSandbox) return { success: false, error: 'run_tests must be a top-level caller; nested execution cannot grant authority' };
    // Native page cancellation is host-options-only; model args cannot supply it.
    var hostSignal = options && options._runTestsAbortSignal;
    if (hostSignal && hostSignal.aborted) return { success: false, error: 'run_tests cancelled before dispatch' };
    var v = rtValidateArgs(args);
    if (!v.ok) return { success: false, error: v.error };
    var a = v.value, started = Date.now(), deadline = started + a.timeout_ms;
    var context = null, controller = new AbortController(), wk, cfg, before, isolation;
    function cancel() { if (context) TestRunPolicy.registry.revoke(context); controller.abort(); }
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
                (Array.isArray(a.files) ? ' in files ' + JSON.stringify(a.files) : ' in test/') + '.';
            return { success: false, error: _noMatch, code: 'NO_TESTS_MATCHED', pattern: a.pattern || null, files: [], summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0 } };
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
        context = TestRunPolicy.registry.open({ workspace: wk, deadline: deadline, allow_tools: a.allow_tools });
        var evalOptions = _rtEvalOptions(options);
        evalOptions._testRunContext = context;
        evalOptions._testRunSignal = controller.signal;
        active();
        evalRes = await budget(executeTool('js_eval', { code: rtBuildSandboxCode(cfg) }, messageIndex, evalOptions));
    } catch (error) {
        evalRes = { success: false, error: String(error && error.message || error) };
    } finally {
        cancel();
        if (hostSignal) hostSignal.removeEventListener('abort', cancel);
    }
    if (!before) return { success: false, error: evalRes && evalRes.error || 'Host baseline failed', isolation: { ok: false, error: 'Baseline unavailable' } };
    try {
        // Independent cleanup budget. Never reopen test authority or mutate scratch.
        var after = await TestRunPolicy.bounded(snapshot(Date.now() + 10000), 10000);
        isolation = TestRunPolicy.compare(before, after);
    } catch (error) { isolation = { ok: false, error: String(error && error.message || error), violations: [] }; }
    var out = rtParseEvalResult(evalRes, cfg || { files: [] }, isolation, context ? TestRunPolicy.registry.denials(context) : []);
    out.duration_ms = Date.now() - started;
    out.workspace = wk;
    return out;
}
