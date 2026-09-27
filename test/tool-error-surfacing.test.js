// B2 coded-error contract, tools side (reload-zombie fix).
//
// Executes REAL code only, with fake peers:
//  * the js_eval outer catch of src/js/tools/020-tool-execution.js, sliced
//    between the B2-JS-EVAL-ERROR-SURFACE markers;
//  * the run_tests / run_js_file entry points of src/js/tools/160-run-tests.js
//    with fake workspace + eval bridges (as in test/run-tests-tool.test.js);
//  * the SW producers in src/platform/extension/background.js:
//    ensureOffscreenDocument (coded 'OFFSCREEN_<CODE>: sentence' errors,
//    _swOffscreenLastError) and callOffscreenHelper (the /not available/
//    not-ready errors, with and without ' (last offscreen error: ...)'),
//    run against a fake chrome with a microtask-only timer.
// So the chain SW error -> js_eval result -> run_tests result is end-to-end.
// No live tool calls, no writes, no real timers.

var HINT = 'Hint: Reload the extension; if the problem persists, check chrome://extensions \u2192 AppAgent \u2192 Errors.';
var CODES = ['OFFSCREEN_CLOSE_TIMEOUT', 'OFFSCREEN_PROBE_TIMEOUT', 'OFFSCREEN_CREATE_TIMEOUT', 'OFFSCREEN_CREATE_FAILED'];
var FALLBACK = 'js_eval failed without an error message (the sandbox may be unavailable).\n' + HINT;
var ROSTER = 'Tool "x" is not available to this sub-agent';

var _tesSources = {};
async function tesSource(path) {
    if (!(path in _tesSources)) _tesSources[path] = await loadFile(path);
    return _tesSources[path];
}
function tesCut(text, from, to) {
    var i = text.indexOf(from);
    if (i < 0) throw new Error('slice start not found: ' + from);
    var j = text.indexOf(to, i + from.length);
    if (j < 0) throw new Error('slice end not found after: ' + from);
    return text.slice(i, j);
}
function tesCount(text, needle) { return String(text).split(needle).length - 1; }

// ── 020: the real js_eval outer-catch mapper (a function of the caught `e`) ──
async function jsEvalCatch() {
    var body = tesCut(await tesSource('src/js/tools/020-tool-execution.js'),
        '// B2-JS-EVAL-ERROR-SURFACE:BEGIN', '// B2-JS-EVAL-ERROR-SURFACE:END');
    return new Function('e', body);
}

// ── background.js: real ensureOffscreenDocument + callOffscreenHelper ──
// Timer that fires after 8 microtask hops: a step whose promise is already
// settled wins; a never-settling step "times out" deterministically.
function microTimer() {
    return {
        set: function(fn) {
            var h = { cleared: false }, p = Promise.resolve();
            for (var k = 0; k < 8; k++) p = p.then(function() {});
            p.then(function() { if (!h.cleared) fn(); });
            return h;
        },
        clear: function(h) { if (h) h.cleared = true; }
    };
}
function swFakeChrome(mode) {
    var offscreen = { hasDocument: function() { return Promise.resolve(false); } };
    var runtime = { sendMessage: function() { return Promise.resolve({ ok: true, result: 'ran' }); } };
    if (mode === 'create-ok') offscreen.createDocument = function() { return Promise.resolve(); };
    if (mode === 'create-hangs') offscreen.createDocument = function() { return new Promise(function() {}); };
    if (mode === 'create-fails' || mode === 'probe-hangs') offscreen.createDocument = function() { return Promise.reject(new Error('boom')); };
    if (mode === 'probe-hangs') runtime.getContexts = function() { return new Promise(function() {}); };
    return { offscreen: offscreen, runtime: runtime };
}
async function swRealm(mode, opts) {
    opts = opts || {};
    var bg = await tesSource('src/platform/extension/background.js');
    var code = 'var _swOffscreenCreating = null, _swOffscreenClosing = null, _swOffscreenIdleSince = 0, _swOffscreenLastError = null;\n' +
        tesCut(bg, '\nfunction ensureOffscreenDocument() {', '\n}\n') + '\n}\n' +
        tesCut(bg, 'function swTestPolicyStartupError()', '// Called by the SW runtime') +
        tesCut(bg, 'async function callOffscreenHelper(', '// Expose to the imported SW bundle.') +
        '\nreturn { ensure: ensureOffscreenDocument, call: callOffscreenHelper, lastError: function() { return _swOffscreenLastError; } };';
    var timer = microTimer(), logs = [];
    var quiet = { log: function() {}, warn: function(m) { logs.push(String(m)); }, error: function(m) { logs.push(String(m)); } };
    var policy = { registry: { bind: function() {}, descriptor: function() { return {}; }, unbind: function() {}, relay: function() { return { ok: false }; } } };
    var api = null;
    // Emulates waitForOffscreenReady on a dead document: it fires
    // ensureOffscreenDocument (which records the coded failure in
    // _swOffscreenLastError) and the keep-alive port never connects.
    var wait = opts.ready ? async function() { return true; }
        : async function() { try { await api.ensure(); } catch (ignored) { /* recorded */ } return false; };
    api = new Function('chrome', 'self', 'console', 'setTimeout', 'clearTimeout', 'crypto', 'TestRunPolicy',
        'waitForOffscreenReady', 'ensureOffscreenResponsive', code)(
        swFakeChrome(mode), { getP4Flag: function() { return false; } }, quiet, timer.set, timer.clear,
        { randomUUID: function() { return 'u1'; } }, policy, wait, opts.responsive);
    api.logs = logs;
    return api;
}
// What js_eval's SW bridge receives from Platform.callOffscreenHelper
// (020 passes 5 min, so the readiness cap in the message is 60000ms).
async function helperRejection(realm) {
    try { await realm.call('helper-js-eval', { code: '1' }, 5 * 60 * 1000); }
    catch (e) { return e; }
    throw new Error('callOffscreenHelper unexpectedly resolved');
}
async function ensureRejection(realm) {
    try { await realm.ensure(); }
    catch (e) { return e; }
    throw new Error('ensureOffscreenDocument unexpectedly resolved');
}

describe('js_eval error surfacing: real SW errors through the 020 catch', function() {
    test('coded ensure failure keeps its CODE: sentence shape and maps to its code with lead + hint', async function() {
        var err = await ensureRejection(await swRealm('create-hangs'));
        assert.strictEqual(err.code, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(err.message.indexOf('OFFSCREEN_CREATE_TIMEOUT: '), 0);
        var r = (await jsEvalCatch())(err);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(r.error, 'js_eval sandbox unavailable: ' + err.message + '\n' + HINT);
    }, { tags: ['unit'], timeout: 5000 });

    test('not-ready rejection with no recorded failure maps to OFFSCREEN_UNAVAILABLE', async function() {
        var realm = await swRealm('create-ok');
        var err = await helperRejection(realm);
        assert.strictEqual(realm.lastError(), null);
        assert.match(err.message, /^Offscreen helper not available \(offscreen_not_ready: /);
        assert.strictEqual(err.message.indexOf('(last offscreen error:'), -1);
        var r = (await jsEvalCatch())(err);
        assert.strictEqual(r.error_code, 'OFFSCREEN_UNAVAILABLE');
        assert.strictEqual(r.error, 'js_eval sandbox unavailable: ' + err.message + '\n' + HINT);
        assert.match(r.error, /not available/);
    }, { tags: ['unit'], timeout: 5000 });

    [['create-hangs', 'OFFSCREEN_CREATE_TIMEOUT'], ['create-fails', 'OFFSCREEN_CREATE_FAILED'], ['probe-hangs', 'OFFSCREEN_PROBE_TIMEOUT']].forEach(function(c) {
        test('not-ready rejection carrying the last ' + c[1] + ' maps to that code', async function() {
            var realm = await swRealm(c[0]);
            var err = await helperRejection(realm);
            var last = realm.lastError();
            assert.ok(last && last.code === c[1] && last.message.indexOf(c[1] + ': ') === 0, 'recorded ' + JSON.stringify(last));
            assert.match(err.message, /^Offscreen helper not available \(offscreen_not_ready: /);
            assert.ok(err.message.endsWith(' (last offscreen error: ' + last.message + ')'), err.message);
            var r = (await jsEvalCatch())(err);
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.error_code, c[1]);
            assert.strictEqual(r.error, 'js_eval sandbox unavailable: ' + err.message + '\n' + HINT);
            assert.match(r.error, /not available/);
            assert.strictEqual(tesCount(r.error, 'Hint: Reload the extension'), 1);
        }, { tags: ['unit'], timeout: 5000 });
    });

    test('unresponsive-document rejection is coded, with and without the suffix', async function() {
        var realm = await swRealm('create-fails', { ready: true, responsive: async function() { return false; } });
        var surf = await jsEvalCatch();
        var plain = await helperRejection(realm);
        assert.match(plain.message, /^Offscreen helper not available \(offscreen_unresponsive: /);
        assert.strictEqual(surf(plain).error_code, 'OFFSCREEN_UNAVAILABLE');
        await ensureRejection(realm);
        var suffixed = await helperRejection(realm);
        assert.ok(suffixed.message.endsWith(' (last offscreen error: ' + realm.lastError().message + ')'), suffixed.message);
        var r = surf(suffixed);
        assert.strictEqual(r.error_code, 'OFFSCREEN_CREATE_FAILED');
        assert.strictEqual(r.error, 'js_eval sandbox unavailable: ' + suffixed.message + '\n' + HINT);
    }, { tags: ['unit'], timeout: 5000 });

    test('every contract code in the SW Error(CODE: sentence) shape maps to itself', async function() {
        var surf = await jsEvalCatch();
        CODES.forEach(function(code) {
            var e = new Error(code + ': the step did not settle within 5000ms'); e.code = code;
            var r = surf(e);
            assert.strictEqual(r.error_code, code);
            assert.strictEqual(r.error, 'js_eval sandbox unavailable: ' + e.message + '\n' + HINT);
        });
    }, { tags: ['unit'], timeout: 2000 });

    test('user and non-offscreen errors keep the pre-B2 {success:false, error} shape', async function() {
        var surf = await jsEvalCatch();
        ['ReferenceError: foo is not defined', 'js_eval timed out after 5 minutes of inactivity (no tool calls or completion)',
            'Offscreen helper execution cancelled', 'Feature is not available', 'Offscreen helper returned no response'].forEach(function(m) {
            assert.deepStrictEqual(surf(new Error(m)), { success: false, error: m });
        });
        assert.deepStrictEqual(surf('thrown string'), { success: false, error: 'thrown string' });
    }, { tags: ['unit'], timeout: 2000 });

    test('a sub-agent roster error ("not available to this sub-agent") gets NO error_code', async function() {
        var r = (await jsEvalCatch())(new Error(ROSTER));
        assert.deepStrictEqual(r, { success: false, error: ROSTER });
        assert.strictEqual('error_code' in r, false);
    }, { tags: ['unit'], timeout: 2000 });

    test('an empty / undefined / [object Object] failure gets the readable fallback and hint, no code', async function() {
        var surf = await jsEvalCatch();
        var renamed = new Error(''); renamed.name = 'Timeout';
        var unset = new Error('x'); unset.message = undefined;
        // Error-shaped but not an instance of this realm's Error (a foreign realm).
        var foreign = Object.create({ name: 'TypeError', message: '', toString: Error.prototype.toString });
        assert.strictEqual(foreign instanceof Error, false);
        assert.strictEqual(String(foreign), 'TypeError');
        [undefined, null, {}, { message: '' }, new Error(String(undefined)), new Error(''), new TypeError(''), new Error(), renamed, unset, foreign].forEach(function(e, i) {
            assert.deepStrictEqual(surf(e), { success: false, error: FALLBACK }, 'case ' + i);
        });
        // A present message, or a thrown primitive, keeps the pre-B2 shape.
        assert.deepStrictEqual(surf(new Error('TypeError')), { success: false, error: 'TypeError' });
        assert.deepStrictEqual(surf('Error'), { success: false, error: 'Error' });
    }, { tags: ['unit'], timeout: 2000 });
});

// ── 160: the real run_tests / run_js_file entry points, fake peers as in
// test/run-tests-tool.test.js (timers inert, isolation fakes are stable) ──
async function runTestsEntry(evalImpl) {
    var P = new Function('setTimeout', 'clearTimeout', (await tesSource('src/js/core/075-test-run-policy.js')) + '\nreturn TestRunPolicy;')(function() { return null; }, function() {});
    var evalCalls = [];
    var entry = new Function('TestRunPolicy', 'resolveWorkspace', 'wsLs', 'wsReadRaw', 'wsStatus', 'executeTool', 'crypto', 'TextEncoder', 'AbortController',
        (await tesSource('src/js/tools/160-run-tests.js')) + '\nreturn { run: executeRunTests, file: executeRunJsFile, helpers: RunTestsHelpers };')(
        P,
        async function(w) { return w || 'owner/repo::main'; },
        async function() { return { success: true, entries: ['a.test.js', 'b.test.js', 'harness.js'] }; },
        async function(w, path) { return { success: true, file: { content: 'source:' + path } }; },
        async function() { return { success: true, dirty_files: [{ path: 'src/dirty.js' }] }; },
        async function(name, args, i, opts) { evalCalls.push(name); return evalImpl(name, args, opts); },
        { subtle: { digest: async function(_, b) { return b.buffer; } } }, TextEncoder, AbortController);
    entry.evalCalls = evalCalls;
    return entry;
}
function envelope(files) { return { success: true, result: { host_test_boundary: true, denied_calls: [], value: { files: files, denied_calls: [] } } }; }
function fr(file, status, p, f, s, extra) { return Object.assign({ file: file, status: status, passed: p, failed: f, skipped: s }, extra || {}); }
var TA = 'test/a.test.js', TB = 'test/b.test.js';
// The js_eval result run_tests receives when the real SW chain fails.
async function chainedEvalResult(mode) { return (await jsEvalCatch())(await helperRejection(await swRealm(mode))); }

describe('run_tests error surfacing (160): coded sandbox errors and the no-tests guard', function() {
    test('A. a normal run stays green with no error_code', async function() {
        var entry = await runTestsEntry(async function() { return envelope([fr(TA, 'pass', 1, 0, 0)]); });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.error_code, undefined);
        assert.strictEqual(r.error, undefined);
        assert.strictEqual(r.tests_ran, undefined);
        assert.strictEqual(r.summary.passed, 1);
        assert.strictEqual(r.isolation.ok, true);
        assert.deepStrictEqual(entry.evalCalls, ['js_eval']);
    }, { tags: ['unit'], timeout: 5000 });

    test('B. a real SW chain failure (create hangs) -> its OFFSCREEN_* code, lead, original text, hint once', async function() {
        var evalRes = await chainedEvalResult('create-hangs');
        assert.strictEqual(evalRes.error_code, 'OFFSCREEN_CREATE_TIMEOUT');
        var orig = evalRes.error.slice('js_eval sandbox unavailable: '.length, evalRes.error.length - ('\n' + HINT).length);
        var entry = await runTestsEntry(async function() { return evalRes; });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(r.tests_ran, 0);
        assert.match(r.error, /^run_tests could not start the sandbox: Offscreen helper not available/);
        assert.ok(r.error.indexOf('(last offscreen error: OFFSCREEN_CREATE_TIMEOUT: ') > 0, r.error);
        assert.ok(r.error.indexOf('(0 tests ran; 1 test file selected)') > 0, r.error);
        assert.strictEqual(r.error.indexOf('js_eval sandbox unavailable: '), -1);
        assert.strictEqual(tesCount(r.error, 'Hint: Reload the extension'), 1);
        assert.ok(r.error.endsWith('\n' + HINT), r.error);
        assert.strictEqual(r.error, 'run_tests could not start the sandbox: ' + orig + ' (0 tests ran; 1 test file selected).\n' + HINT);
        assert.deepStrictEqual(entry.evalCalls, ['js_eval']);
    }, { tags: ['unit'], timeout: 5000 });

    test('C. the no-suffix chain (document created, port never connects) -> OFFSCREEN_UNAVAILABLE', async function() {
        var entry = await runTestsEntry(async function() { return chainedEvalResult('create-ok'); });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'OFFSCREEN_UNAVAILABLE');
        assert.strictEqual(r.tests_ran, 0);
        assert.match(r.error, /^run_tests could not start the sandbox: Offscreen helper not available \(offscreen_not_ready: /);
        assert.strictEqual(r.error.indexOf('(last offscreen error:'), -1);
        assert.strictEqual(tesCount(r.error, 'Hint: Reload the extension'), 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('D. a code carried only in error_code is kept', async function() {
        var entry = await runTestsEntry(async function() { return { success: false, error: 'helper wedged', error_code: 'OFFSCREEN_PROBE_TIMEOUT' }; });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'OFFSCREEN_PROBE_TIMEOUT');
        assert.strictEqual(r.error, 'run_tests could not start the sandbox: helper wedged (0 tests ran; 1 test file selected).\n' + HINT);
    }, { tags: ['unit'], timeout: 5000 });

    test('E. a non-offscreen eval error -> NO_TESTS_RAN keeping the original text', async function() {
        var entry = await runTestsEntry(async function() { return { success: false, error: 'channel failed' }; });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.strictEqual(r.tests_ran, 0);
        assert.match(r.error, /^NO_TESTS_RAN: 0 tests ran /);
        assert.ok(r.error.indexOf('1 test file selected, but the sandbox returned no file results') > 0, r.error);
        assert.ok(r.error.indexOf('channel failed') > 0, r.error);
        assert.strictEqual(r.error.indexOf('Hint: Reload the extension'), -1);
    }, { tags: ['unit'], timeout: 5000 });

    test('F. a sub-agent roster error -> NO_TESTS_RAN, never an OFFSCREEN_* code', async function() {
        var entry = await runTestsEntry(async function() { return { success: false, error: ROSTER }; });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.ok(r.error.indexOf(ROSTER) > 0, r.error);
        assert.strictEqual(/OFFSCREEN_/.test(r.error), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('G. 0 matched files -> NO_TESTS_MATCHED + NO_TESTS_RAN, and no eval is dispatched', async function() {
        var entry = await runTestsEntry(async function() { throw new Error('eval must not be dispatched'); });
        var r = await entry.run({ pattern: 'zzz_no_such' }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.code, 'NO_TESTS_MATCHED');
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.strictEqual(r.tests_ran, 0);
        assert.strictEqual(r.summary.total, 0);
        assert.match(r.error, /^NO_TESTS_MATCHED: no test files matched pattern "zzz_no_such" in test\/\./);
        assert.match(r.error, /0 test files selected/);
        var r2 = await entry.run({ files: [TA], pattern: 'zzz_no_such' }, 0, {});
        assert.strictEqual(r2.code, 'NO_TESTS_MATCHED');
        assert.strictEqual(r2.error_code, 'NO_TESTS_RAN');
        assert.match(r2.error, / in files \["test\/a\.test\.js"\]\./);
        assert.strictEqual(entry.evalCalls.length, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('H. files loaded but 0 tests ran (empty file) -> NO_TESTS_RAN', async function() {
        var entry = await runTestsEntry(async function() { return envelope([fr(TA, 'empty', 0, 0, 0)]); });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.strictEqual(r.tests_ran, 0);
        assert.match(r.error, /1 test file selected, 1 loaded but no test ran \(1 file registered no tests, 0 tests skipped\)/);
    }, { tags: ['unit'], timeout: 5000 });

    test('I. an all-skipped run is not green: NO_TESTS_RAN saying the tests were skipped', async function() {
        var entry = await runTestsEntry(async function() { return envelope([fr(TA, 'pass', 0, 0, 3)]); });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.strictEqual(r.tests_ran, 0);
        assert.strictEqual(r.summary.skipped, 3);
        assert.strictEqual(r.isolation.ok, true);
        assert.match(r.error, /3 tests skipped/);
        assert.match(r.error, /\(0 files registered no tests, 3 tests skipped\)/);
        assert.strictEqual(/sandbox/i.test(r.error), false);
        var one = await (await runTestsEntry(async function() { return envelope([fr(TA, 'pass', 0, 0, 1)]); })).run({ files: [TA] }, 0, {});
        assert.match(one.error, /\(0 files registered no tests, 1 test skipped\)/);
    }, { tags: ['unit'], timeout: 5000 });

    test('J. a load error -> NO_TESTS_RAN naming the first failing file', async function() {
        var entry = await runTestsEntry(async function() { return envelope([fr(TA, 'error', 0, 0, 0, { error: 'SyntaxError: x' })]); });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.match(r.error, /0 loaded but no test ran/);
        assert.match(r.error, /1 failed to load, first: test\/a\.test\.js: SyntaxError: x\)/);
    }, { tags: ['unit'], timeout: 5000 });

    test('K. once any test ran the guard stays out (plain failure, no error_code)', async function() {
        var entry = await runTestsEntry(async function() { return envelope([fr(TA, 'pass', 1, 0, 0), fr(TB, 'empty', 0, 0, 0)]); });
        var r = await entry.run({ files: [TA, TB] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, undefined);
        assert.strictEqual(r.tests_ran, undefined);
        assert.strictEqual(r.summary.passed, 1);
        assert.strictEqual(r.error, 'Test failure, denied tool call or unverified isolation');
    }, { tags: ['unit'], timeout: 5000 });

    test('L. run_js_file passes a coded js_eval error through; a plain one stays uncoded', async function() {
        var evalRes = await chainedEvalResult('create-hangs');
        var entry = await runTestsEntry(async function() { return evalRes; });
        var r = await entry.file({ path: 'x.js' }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'OFFSCREEN_CREATE_TIMEOUT');
        assert.strictEqual(r.error, evalRes.error);
        assert.deepStrictEqual(entry.evalCalls, ['js_eval']);
        var plain = await (await runTestsEntry(async function() { return { success: false, error: 'boom' }; })).file({ path: 'x.js' }, 0, {});
        assert.strictEqual(plain.error, 'boom');
        assert.strictEqual(plain.error_code, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('M. js_eval (020) and run_tests (160) classify every SW shape identically', async function() {
        var surf = await jsEvalCatch();
        var helpers = (await runTestsEntry(async function() { return envelope([]); })).helpers;
        var corpus = [];
        for (var mode of ['create-ok', 'create-hangs', 'create-fails', 'probe-hangs']) corpus.push((await helperRejection(await swRealm(mode))).message);
        for (var mode2 of ['create-hangs', 'create-fails', 'probe-hangs']) corpus.push((await ensureRejection(await swRealm(mode2))).message);
        var unresp = await swRealm('create-fails', { ready: true, responsive: async function() { return false; } });
        corpus.push((await helperRejection(unresp)).message);
        await ensureRejection(unresp);
        corpus.push((await helperRejection(unresp)).message);
        CODES.forEach(function(code) { corpus.push(code + ': the step did not settle within 5000ms'); });
        corpus.push(ROSTER, 'Feature is not available', 'ReferenceError: foo is not defined',
            'js_eval timed out after 5 minutes of inactivity (no tool calls or completion)', 'Offscreen helper execution cancelled', 'Offscreen helper returned no response');
        var coded = 0;
        corpus.forEach(function(m) {
            var j = surf(new Error(m)), jc = j.error_code || null;
            assert.strictEqual(jc, helpers.rtSandboxErrorCode(m), 'raw: ' + m);
            // What run_tests re-derives from the js_eval result it receives.
            assert.strictEqual(helpers.rtSandboxErrorCode(j.error, j.error_code), jc, 'chained: ' + m);
            if (jc) coded++;
        });
        assert.strictEqual(corpus.length, 19);
        assert.strictEqual(coded, 13);
    }, { tags: ['unit'], timeout: 5000 });

    test('N. the 020 empty-message fallback reaches run_tests as NO_TESTS_RAN with its hint once', async function() {
        var evalRes = (await jsEvalCatch())(new TypeError(''));
        assert.deepStrictEqual(evalRes, { success: false, error: FALLBACK });
        var entry = await runTestsEntry(async function() { return evalRes; });
        var r = await entry.run({ files: [TA] }, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error_code, 'NO_TESTS_RAN');
        assert.ok(r.error.indexOf('js_eval failed without an error message') > 0, r.error);
        assert.strictEqual(tesCount(r.error, 'Hint: Reload the extension'), 1);
    }, { tags: ['unit'], timeout: 5000 });
});
