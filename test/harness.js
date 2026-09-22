// =============================================================
// AppAgent test harness — runs INSIDE the js_eval sandbox (no Node, no fs,
// no require). Loaded from a host-captured source by the run_tests tool
// and installed on the sandbox window with H.install(window).
//
// Test files (test/*.test.js) are evaluated with evalModule after install, so
// they see these globals: describe, test, test.skip, beforeEach, afterEach,
// assert, scratchPath, plus the sandbox's own executeTool / sleep / loadFile /
// runFile / evalModule.
//
// Layers (selected by run_tests {tags}):
//   unit     — runFile() the REAL module and test the real function
//   contract — UNSUPPORTED while the host read-only policy is active; skipped
//              before body/hooks run, including scratch-write contracts
//   runtime  — likewise unsupported/skipped in host read-only runs
//   canary   — tiny liveness/round-trip smoke checks
// Default tags: ['unit', 'contract', 'canary'].
// =============================================================

var HARNESS_DEFAULT_TIMEOUT_MS = 30000;
var HARNESS_AFTER_TIMEOUT_MS = 5000;   // afterEach budget; cleanup NEVER runs after timeout
var HARNESS_STACK_MAX = 800;
var HARNESS_SCRATCH_PREFIX = 'test/.scratch/';
var HARNESS_FINGERPRINT_MAX_FILES = 60;  // dirty non-scratch files fingerprinted per snapshot (one `workspace read` each)

function _hIsDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        return (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b));
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Date || b instanceof Date) return (a instanceof Date) && (b instanceof Date) && a.getTime() === b.getTime();
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
        if (!_hIsDeepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
}

function _hShow(v) {
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : (s.length > 200 ? s.slice(0, 200) + '…' : s); }
    catch (e) { return String(v); }
}

function AssertionError(message) {
    var e = new Error(message);
    e.name = 'AssertionError';
    e.isAssertion = true;
    return e;
}

function _hMatchesExpected(err, expected) {
    if (expected == null) return true;
    if (expected instanceof RegExp) return expected.test(err && (err.message || String(err)));
    if (typeof expected === 'function') {
        if (expected.prototype !== undefined && err instanceof expected) return true;
        if (Error.isPrototypeOf(expected)) return false;
        return expected(err) === true;
    }
    if (typeof expected === 'object') {
        return Object.keys(expected).every(function(k) {
            var want = expected[k], got = err && err[k];
            return want instanceof RegExp ? want.test(String(got)) : _hIsDeepEqual(got, want);
        });
    }
    return true;
}

var assert = {
    // Every method below is wrapped after this literal (see _hCountAssertions) so
    // the harness can count assertions per test: a test that made none gets
    // status 'no_assertions' (a failure) unless registered with {noAssert:true}.
    ok: function(v, msg) { if (!v) throw AssertionError(msg || 'Expected truthy value, got ' + _hShow(v)); },
    equal: function(a, b, msg) { if (a != b) throw AssertionError(msg || 'Expected ' + _hShow(a) + ' == ' + _hShow(b)); },
    strictEqual: function(a, b, msg) { if (a !== b) throw AssertionError(msg || 'Expected ' + _hShow(a) + ' === ' + _hShow(b)); },
    notStrictEqual: function(a, b, msg) { if (a === b) throw AssertionError(msg || 'Expected values to differ, both ' + _hShow(a)); },
    deepStrictEqual: function(a, b, msg) { if (!_hIsDeepEqual(a, b)) throw AssertionError(msg || 'Expected deep equality:\n  actual:   ' + _hShow(a) + '\n  expected: ' + _hShow(b)); },
    match: function(s, re, msg) { if (!(re instanceof RegExp) || !re.test(String(s))) throw AssertionError(msg || 'Expected ' + _hShow(s) + ' to match ' + String(re)); },
    fail: function(msg) { throw AssertionError(msg || 'assert.fail()'); },
    throws: function(fn, expected, msg) {
        if (typeof expected === 'string') { msg = expected; expected = undefined; }
        var threw = false, err;
        try { fn(); } catch (e) { threw = true; err = e; }
        if (!threw) throw AssertionError(msg || 'Expected function to throw');
        if (!_hMatchesExpected(err, expected)) throw AssertionError(msg || 'Thrown error did not match expectation: ' + (err && err.message));
    },
    rejects: async function(p, expected, msg) {
        if (typeof expected === 'string') { msg = expected; expected = undefined; }
        var rejected = false, err;
        try { await (typeof p === 'function' ? p() : p); } catch (e) { rejected = true; err = e; }
        if (!rejected) throw AssertionError(msg || 'Expected promise to reject');
        if (!_hMatchesExpected(err, expected)) throw AssertionError(msg || 'Rejection did not match expectation: ' + (err && err.message));
    }
};

// ─── registry ────────────────────────────────────────────────────────────────
// current: the active sequential test. On any timeout aborted is permanent for
// this harness instance: no later test/file context opens and assertion counting
// stops. Per-test body/bridge closures capture lexical contexts. The host destroys
// the exact iframe; Promise.race alone is explicitly NOT treated as cancellation.
var _hState = { file: null, suites: [], stack: [], running: false, current: null, aborted: false, late_failures: [] };

function _hCountAssertions(obj) {
    Object.keys(obj).forEach(function(k) {
        var orig = obj[k];
        if (typeof orig !== 'function') return;
        obj[k] = function() { if (_hState.current && !_hState.aborted) _hState.current.assertions++; return orig.apply(this, arguments); };
    });
    return obj;
}
_hCountAssertions(assert);

function _hCurrent() { return _hState.stack.length ? _hState.stack[_hState.stack.length - 1] : _hRoot(); }
function _hRoot() {
    if (!_hState.suites.length || _hState.suites[0].name !== '') _hState.suites.unshift({ name: '', tests: [], before: [], after: [] });
    return _hState.suites[0];
}

function reset(file) { _hState.file = file || null; _hState.suites = []; _hState.stack = []; }

function describe(name, fn) {
    var suite = { name: String(name), tests: [], before: [], after: [], parent: _hState.stack.length ? _hCurrent() : null };
    _hState.suites.push(suite);
    _hState.stack.push(suite);
    try { var r = fn(); if (r && typeof r.then === 'function') throw new Error('describe(' + name + ') callback must be synchronous (register tests, do not await)'); }
    finally { _hState.stack.pop(); }
}

function _hRegister(name, fn, opts, skip) {
    if (typeof fn !== 'function' && !skip) throw new Error('test(' + name + '): second argument must be a function');
    opts = opts || {};
    var tags = Array.isArray(opts.tags) ? opts.tags.slice() : (typeof opts.tags === 'string' ? [opts.tags] : ['unit']);
    // timeout: per-test override only; null = resolved at run() time (opts.timeout_ms, else HARNESS_DEFAULT_TIMEOUT_MS)
    _hCurrent().tests.push({ name: String(name), fn: fn, tags: tags, timeout: (Number(opts.timeout) > 0 ? Number(opts.timeout) : null), skip: !!skip, noAssert: !!opts.noAssert });
}
function test(name, fn, opts) { _hRegister(name, fn, opts, false); }
test.skip = function(name, fn, opts) { _hRegister(name, fn, opts, true); };
function beforeEach(fn) { _hCurrent().before.push(fn); }
function afterEach(fn) { _hCurrent().after.push(fn); }

function _hHooks(suite, key) {
    var chain = [];
    for (var s = suite; s; s = s.parent) chain.unshift(s);
    if (chain[0].name !== '' && _hState.suites[0] && _hState.suites[0].name === '') chain.unshift(_hState.suites[0]);
    var out = [];
    chain.forEach(function(s) { out = out.concat(s[key]); });
    return key === 'after' ? out.reverse() : out;
}

function _hWithTimeout(promise, ms, label) {
    var timer;
    return Promise.race([
        promise,
        new Promise(function(_, rej) { timer = setTimeout(function() { var e = new Error('Test timed out after ' + ms + 'ms: ' + label); e.code = 'HARNESS_TIMEOUT'; rej(e); }, ms); })
    ]).then(function(v) { clearTimeout(timer); return v; }, function(e) { clearTimeout(timer); throw e; });
}

function _hErr(e) {
    var msg = e && e.message != null ? String(e.message) : String(e);
    var stack = e && e.stack ? String(e.stack) : '';
    return { message: msg.slice(0, 1000), stack: stack.slice(0, HARNESS_STACK_MAX), assertion: !!(e && e.isAssertion) };
}

// Run every registered test whose tags intersect opts.tags (all when omitted).
// opts.timeout_ms: per-test timeout for tests registered WITHOUT their own
// {timeout} (default HARNESS_DEFAULT_TIMEOUT_MS); a per-test {timeout} always wins.
// opts.dev_mode: true when the extension dev-mode gate is active; otherwise
// every `runtime`-tagged test is skipped with reason "runtime: dev mode not
// active" (runtime_inspect is hidden outside dev mode, so the layer cannot run).
// Statuses: pass | fail | skip | no_assertions (a pass with zero assert.* calls
// and no {noAssert:true} — counted as a FAILURE).
// Returns { file, passed, failed, skipped, no_assertions, late_failures, tests:[{name,file,tags,status,duration_ms,error?}] }.
async function run(opts) {
    opts = opts || {};
    if (_hState.aborted) throw new Error('Harness aborted after timeout; use a new host invocation');
    var want = Array.isArray(opts.tags) && opts.tags.length ? opts.tags : null;
    var defaultTimeout = Number(opts.timeout_ms) > 0 ? Number(opts.timeout_ms) : HARNESS_DEFAULT_TIMEOUT_MS;
    var devMode = opts.dev_mode === true;
    var results = [];
    var pending = 0;
    _hState.late_failures = [];
    for (var si = 0; si < _hState.suites.length && !_hState.aborted; si++) {
        var suite = _hState.suites[si];
        for (var ti = 0; ti < suite.tests.length && !_hState.aborted; ti++) {
            let t = suite.tests[ti];
            let fullName = suite.name ? suite.name + ' › ' + t.name : t.name;
            let rec = { name: fullName, file: _hState.file, tags: t.tags, status: 'pass', duration_ms: 0 };
            var tagged = !want || t.tags.some(function(tag) { return want.indexOf(tag) >= 0; });
            if (t.skip || !tagged) { rec.status = 'skip'; rec.reason = t.skip ? 'test.skip' : 'tag filter'; results.push(rec); continue; }
            if (opts.read_only_host && (t.tags.indexOf('contract') >= 0 || t.tags.indexOf('runtime') >= 0)) { rec.status = 'skip'; rec.reason = 'unsupported: live contract/runtime tools disabled by host read-only policy'; results.push(rec); continue; }
            if (!devMode && t.tags.indexOf('runtime') >= 0) { rec.status = 'skip'; rec.reason = 'runtime: dev mode not active'; results.push(rec); continue; }
            var t0 = Date.now();
            let ctx = { name: fullName, assertions: 0, denied: [], token: { settled: false } };
            _hState.current = ctx;
            let befores = _hHooks(suite, 'before'), afters = _hHooks(suite, 'after');
            // Lexical attribution; ANY timeout aborts this invocation. No next
            // test/file context is opened while a timed-out body could still run.
            let body = (async function() {
                for (var b = 0; b < befores.length; b++) await befores[b]();
                await t.fn();
            })();
            body.then(null, function(e) { if (ctx.token.settled) _hState.late_failures.push({ test: fullName, file: _hState.file, message: _hErr(e).message }); });
            try {
                await _hWithTimeout(body, t.timeout || defaultTimeout, fullName);
            } catch (e) {
                if (e && e.code === 'HARNESS_SKIP') { rec.status = 'skip'; rec.reason = e.message; }
                else { rec.status = 'fail'; rec.error = _hErr(e); }
                if (e && e.code === 'HARNESS_TIMEOUT') { _hState.aborted = true; if (opts.onTimeout) opts.onTimeout(); }
            }
            ctx.token.settled = true;
            // Cleanup has its own bounded budget, but NEVER follows a timeout.
            try {
                if (!_hState.aborted) await _hWithTimeout((async function() { for (var a = 0; a < afters.length; a++) await afters[a](); })(), HARNESS_AFTER_TIMEOUT_MS, fullName + ' (afterEach)');
            } catch (e2) {
                if (rec.status === 'pass') { rec.status = 'fail'; rec.error = _hErr(e2); }
                else rec.after_error = _hErr(e2).message;
                if (e2 && e2.code === 'HARNESS_TIMEOUT') { _hState.aborted = true; if (opts.onTimeout) opts.onTimeout(); }
            }
            if (ctx.denied.length) {
                rec.denied_calls = ctx.denied.slice();
                if (rec.status === 'pass') { rec.status = 'fail'; rec.error = { message: 'harness denied tool call(s): ' + ctx.denied.map(function(d) { return d.tool + (d.action ? ':' + d.action : ''); }).join(', ') + ' (host policy cannot grant mutations)' , stack: '', assertion: false }; }
            }
            if (rec.status === 'pass' && ctx.assertions === 0 && !t.noAssert) {
                rec.status = 'no_assertions';
                rec.error = { message: 'test made no assertions (call assert.* or register with {noAssert:true})', stack: '', assertion: false };
            }
            rec.assertions = ctx.assertions;
            _hState.current = null;
            rec.duration_ms = Date.now() - t0;
            results.push(rec);
            if (typeof opts.onTest === 'function') { try { await opts.onTest(rec, ++pending); } catch (e) { /* heartbeat failures never fail a test */ } }
        }
    }
    var tally = { aborted: _hState.aborted, file: _hState.file, passed: 0, failed: 0, skipped: 0, no_assertions: 0, late_failures: _hState.late_failures.slice(), tests: results };
    results.forEach(function(r) {
        if (r.status === 'pass') tally.passed++;
        else if (r.status === 'fail') tally.failed++;
        else if (r.status === 'no_assertions') { tally.failed++; tally.no_assertions++; }
        else tally.skipped++;
    });
    return tally;
}

// Skip from inside a test body (e.g. runtime layer when runtime_inspect is unavailable).
function skip(reason) { var e = new Error(reason || 'skipped'); e.code = 'HARNESS_SKIP'; throw e; }

// ─── contract-layer helpers ──────────────────────────────────────────────────
function scratchPath(name) {
    var clean = String(name || 'file').replace(/^\/+/, '').replace(/\.\./g, '_');
    return HARNESS_SCRATCH_PREFIX + clean;
}
// Scratch = under test/.scratch/ AND no `..` segment (a traversal like
// test/.scratch/../../src/x.js must never count as scratch for the tool guard).
function isScratchPath(p) { return typeof p === 'string' && p.indexOf(HARNESS_SCRATCH_PREFIX) === 0 && !/(^|\/)\.\.(\/|$)/.test(p); }

// Cheap content fingerprint: length + FNV-1a 32-bit hex. Not cryptographic — it
// only has to notice that a dirty file's content changed during the run.
function fingerprint(s) {
    s = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return s.length + ':' + ('0000000' + h.toString(16)).slice(-8);
}

// Dirty-set snapshot via the real workspace tool (executeTool is a sandbox global).
async function snapshotDirty(workspace) {
    var r = await executeTool('workspace', { action: 'status', workspace: workspace, include_git_ignored: true });
    if (!r || r.success !== true || !Array.isArray(r.dirty_files) || r.capped || r.truncated || r._cached) throw new Error('Dirty snapshot failed or capped');
    var files = r.dirty_files;
    return files.map(function(f) { return f.path; }).sort();
}
// Dirty-set snapshot WITH a content fingerprint of every dirty non-scratch file
// (one `workspace read` each, capped at HARNESS_FINGERPRINT_MAX_FILES), so
// checkIsolation can flag a test that edits an ALREADY-dirty file — a path-only
// diff cannot see that. Shape: { paths:[...], fingerprints:{path:'len:hash'}, capped:bool }.
async function snapshotDirtyState(workspace) {
    var paths = await snapshotDirty(workspace);
    var fps = {}, targets = paths.filter(function(p) { return !isScratchPath(p); });
    var capped = targets.length > HARNESS_FINGERPRINT_MAX_FILES;
    if (capped) throw new Error('Dirty snapshot fingerprint cap exceeded');
    for (var i = 0; i < targets.length; i++) {
        try {
            var r = await executeTool('workspace', { action: 'read', path: targets[i], workspace: workspace });
            if (!r || r.success !== true || typeof r.content !== 'string' || r.capped || r.truncated || r._cached) throw new Error('Dirty snapshot read failed');
            fps[targets[i]] = fingerprint(r.content);
        } catch (e) { throw new Error('Dirty snapshot read failed: ' + targets[i]); }
    }
    return { paths: paths, fingerprints: fps, capped: capped };
}
// Diagnostic isolation helper (NOT the authoritative host check). Requires a
// complete uncapped snapshotDirtyState() baseline; path-only arrays fail closed. Violations:
//   * a NEW dirty path outside test/.scratch/
//   * a path that was already dirty whose content fingerprint CHANGED
// Returns { ok, violations, new_dirty, changed, scratch_leftovers }.
async function checkIsolation(before, workspace) {
    if (!before || Array.isArray(before) || before.capped || !Array.isArray(before.paths) || !before.fingerprints) throw new Error('Complete uncapped baseline required');
    var beforePaths = before.paths;
    var beforeFps = (before && !Array.isArray(before) && before.fingerprints) || null;
    var after = beforeFps ? await snapshotDirtyState(workspace) : { paths: await snapshotDirty(workspace), fingerprints: {} };
    var newDirty = after.paths.filter(function(p) { return beforePaths.indexOf(p) < 0; });
    var newOutside = newDirty.filter(function(p) { return !isScratchPath(p); });
    var changed = [];
    if (beforeFps) {
        Object.keys(beforeFps).forEach(function(p) {
            var now = after.fingerprints[p];
            // still dirty with a different fingerprint → the run edited it. (A path that
            // is no longer dirty was discarded/pushed — also a mutation → flagged.)
            if (after.paths.indexOf(p) < 0 || (now !== undefined && now !== beforeFps[p])) changed.push(p);
        });
    }
    var violations = newOutside.concat(changed.filter(function(p) { return newOutside.indexOf(p) < 0; })).sort();
    var leftovers = newDirty.filter(isScratchPath);
    return { ok: violations.length === 0, violations: violations, new_dirty: newOutside, changed: changed, scratch_leftovers: leftovers };
}
// Live scratch cleanup is unsupported, just like every other mutation. The
// trusted runner never invokes sandbox cleanup and never reopens authority.
async function cleanupScratch() { throw new Error('unsupported: all live mutations including scratch cleanup are disabled'); }
// Cheap nested tool call — resets js_eval's inactivity clock between tests.
async function heartbeat(workspace) {
    try { await executeTool('run_js_file', { path: 'test/harness.js', mode: 'source', workspace: workspace }); } catch (e) { /* ignore */ }
}

// ─── bridge diagnostics only ────────────────────────────────────────────────
// Host page/offscreen/SW ingress owns authority. This wrapper deliberately does
// NOT implement a security boundary, expose the raw bridge, or offer restore().
// All calls reach the host decision so a test cannot erase a denial by modifying
// this sandbox object. installToolGuard is retained as a compatibility API name.
function toolDecision(name, args) {
    args = args || {};
    if (name === '__sandbox_sleep') return { ok: true };
    if (name === 'run_js_file' && args.mode === 'source') return { ok: true };
    if (name === 'workspace' && ['read', 'ls', 'grep'].indexOf(args.action) >= 0) return { ok: true };
    return { ok: false, reason: 'Unsupported by default host read-only policy (diagnostic only)' };
}
function installToolGuard(target) {
    target = target || (typeof window !== 'undefined' ? window : globalThis);
    var bridge = target.executeTool;
    if (typeof bridge !== 'function') throw new Error('installToolGuard: target.executeTool is not a function');
    var denied = [];
    target.executeTool = async function(name, args) {
        var ctx = _hState.current, file = _hState.file;
        var result = await bridge.call(target, name, args);
        if (result && result.denied_by_host) {
            var record = { tool: String(name), action: args && args.action, test: ctx && ctx.name, file: file, reason: result.error };
            denied.push(record);
            if (ctx) ctx.denied.push(record);
        }
        return result;
    };
    return { allow_tools: [], denied_calls: denied, authority: 'host-only' };
}

// ─── real-module stubs (for loadModules opts.globals) ────────────────────────
// Minimal in-memory chrome.* fake. Every call is logged in fake._calls
// [{api:'runtime.sendMessage', args:[...]}]. Override any leaf via `overrides`
// (deep-merged one level: fakeChrome({ tabs: { query: async () => [...] } })).
function _hEvent() {
    var ls = [];
    return { _listeners: ls, addListener: function(fn) { ls.push(fn); }, removeListener: function(fn) { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); },
        hasListener: function(fn) { return ls.indexOf(fn) >= 0; }, hasListeners: function() { return ls.length > 0; },
        _fire: function() { var a = arguments; return ls.map(function(fn) { return fn.apply(null, a); }); } };
}
function fakeChrome(overrides) {
    var calls = [], store = {};
    function log(api, args) { calls.push({ api: api, args: Array.prototype.slice.call(args) }); }
    function cb(value, callback) { if (typeof callback === 'function') { callback(value); return undefined; } return Promise.resolve(value); }
    var fake = {
        _calls: calls, _store: store,
        runtime: {
            id: 'fake-extension-id', lastError: undefined,
            getURL: function(p) { return 'chrome-extension://fake-extension-id/' + String(p || '').replace(/^\/+/, ''); },
            sendMessage: function(msg, callback) { log('runtime.sendMessage', arguments); var handlers = fake.runtime.onMessage._listeners; var reply; handlers.forEach(function(h) { try { var r = h(msg, { id: fake.runtime.id }, function(v) { reply = v; }); if (r && typeof r.then === 'function') reply = r; } catch (e) {} }); return cb(reply, typeof callback === 'function' ? callback : undefined); },
            onMessage: _hEvent(), onConnect: _hEvent(), onInstalled: _hEvent(), onStartup: _hEvent(),
            connect: function() { log('runtime.connect', arguments); return { name: arguments[0] && arguments[0].name, postMessage: function() {}, disconnect: function() {}, onMessage: _hEvent(), onDisconnect: _hEvent() }; },
            getManifest: function() { return { version: '0.0.0-test', manifest_version: 3 }; }
        },
        storage: {
            local: {
                get: function(keys, callback) { log('storage.local.get', arguments); var out = {};
                    if (keys == null) out = Object.assign({}, store);
                    else if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }
                    else if (Array.isArray(keys)) keys.forEach(function(k) { if (k in store) out[k] = store[k]; });
                    else Object.keys(keys).forEach(function(k) { out[k] = k in store ? store[k] : keys[k]; });
                    return cb(out, callback); },
                set: function(items, callback) { log('storage.local.set', arguments); Object.keys(items || {}).forEach(function(k) { store[k] = items[k]; }); return cb(undefined, callback); },
                remove: function(keys, callback) { log('storage.local.remove', arguments); (Array.isArray(keys) ? keys : [keys]).forEach(function(k) { delete store[k]; }); return cb(undefined, callback); },
                clear: function(callback) { log('storage.local.clear', arguments); Object.keys(store).forEach(function(k) { delete store[k]; }); return cb(undefined, callback); }
            },
            onChanged: _hEvent()
        },
        tabs: { _tabs: [], query: function(q, callback) { log('tabs.query', arguments); return cb(fake.tabs._tabs.slice(), callback); }, sendMessage: function() { log('tabs.sendMessage', arguments); return Promise.resolve(undefined); }, onUpdated: _hEvent(), onRemoved: _hEvent() },
        offscreen: { _has: false, createDocument: function() { log('offscreen.createDocument', arguments); fake.offscreen._has = true; return Promise.resolve(); }, hasDocument: function() { return Promise.resolve(fake.offscreen._has); }, closeDocument: function() { log('offscreen.closeDocument', arguments); fake.offscreen._has = false; return Promise.resolve(); } }
    };
    if (fake.storage.local) fake.storage.session = fake.storage.local;
    Object.keys(overrides || {}).forEach(function(api) { fake[api] = Object.assign(fake[api] || {}, overrides[api]); });
    return fake;
}
// Minimal window fake: event listeners recorded in _listeners, postMessage in
// _posted, location/navigator/document placeholders. Pass overrides to extend.
function fakeWindow(overrides) {
    var listeners = {}, posted = [];
    var w = {
        _listeners: listeners, _posted: posted,
        addEventListener: function(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener: function(type, fn) { var l = listeners[type] || []; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
        dispatchEvent: function(ev) { (listeners[(ev && ev.type) || ''] || []).forEach(function(fn) { fn(ev); }); return true; },
        postMessage: function(msg, origin) { posted.push({ message: msg, origin: origin }); },
        location: { href: 'chrome-extension://fake-extension-id/panel.html', origin: 'chrome-extension://fake-extension-id', protocol: 'chrome-extension:', pathname: '/panel.html', search: '', hash: '' },
        navigator: { userAgent: 'AppAgentTestHarness/1.0', language: 'en-US', onLine: true },
        document: null, localStorage: null, innerWidth: 1280, innerHeight: 800,
        setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
    };
    w.self = w; w.window = w;
    return Object.assign(w, overrides || {});
}

// ─── legacy runner bridge ────────────────────────────────────────────────────
// loadSources(['a.js', …]) → { 'a.js': text }; loadSources({ bg: 'a.js' }) → { bg: text }.
async function loadSources(spec, workspace) {
    var out = {};
    var keys = Array.isArray(spec) ? spec : Object.keys(spec);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i], p = Array.isArray(spec) ? k : spec[k];
        out[k] = await loadFile(p, workspace);
    }
    return out;
}
// registerRunner(suite, async () => runner(sources)) adapts the pre-harness
// runner shape into describe/test records: an array of {name, passed, error?}
// (one test each), {passed, total, results|tests} (records + a tally test), or
// an array of passed-check NAMES from a throw-on-first-failure runner (one
// passing test per name; a rejection becomes one failing test carrying the
// error). Must be awaited at the test file's top level (before H.run()).
// Throw-on-first-failure runners lose the checks that passed BEFORE the throw.
// Two opt-in ways to preserve them: call `progress.pass(name)` on the object
// passed as the runner's first argument, or attach the names to the thrown
// error (`err.passed = checks`). Legacy runners that do neither still collapse
// to a single failing test (documented limitation of the legacy API).
// Name-only checks are registered with {noAssert:true}: the assertion happened
// inside the legacy runner, which only reports a name once it passed.
async function registerRunner(suiteName, runner) {
    var out, err, progressed = [];
    var progress = { pass: function(name) { progressed.push(String(name)); } };
    try { out = await runner(progress); } catch (e) { err = e; }
    describe(suiteName, function() {
        if (err) {
            var prior = progressed.concat(Array.isArray(err && err.passed) ? err.passed.map(String) : []);
            prior.forEach(function(n) { test(n, function() {}, { noAssert: true }); });
            test('runner completed without throwing', function() { throw err; });
            return;
        }
        var list = Array.isArray(out) ? out : (out && Array.isArray(out.results) ? out.results : (out && Array.isArray(out.tests) ? out.tests : null));
        if (!list && out && typeof out.passed === 'number' && typeof out.total === 'number') list = [];
        if (!list) { test('runner returned results', function() { assert.fail('unexpected runner result: ' + _hShow(out)); }); return; }
        list.forEach(function(r, i) {
            if (typeof r === 'string') { test(r, function() {}, { noAssert: true }); return; }
            var name = (r && r.name) || ('check #' + (i + 1));
            test(name, function() {
                assert.ok(r && r.passed, (r && (r.error || r.message)) || (r && r.actual !== undefined ? 'actual ' + _hShow(r.actual) + ', expected ' + _hShow(r.expected) : 'runner reported failure'));
            });
        });
        if (out && !Array.isArray(out) && typeof out.passed === 'number' && typeof out.total === 'number') {
            test('tally ' + out.passed + '/' + out.total, function() { assert.strictEqual(out.passed, out.total, 'runner tally mismatch'); });
        }
    });
}

function install(target) {
    target = target || (typeof window !== 'undefined' ? window : globalThis);
    target.describe = describe; target.test = test; target.it = test;
    target.beforeEach = beforeEach; target.afterEach = afterEach;
    target.assert = assert; target.scratchPath = scratchPath; target.skipTest = skip;
    target.fakeChrome = fakeChrome; target.fakeWindow = fakeWindow;
    target.registerRunner = registerRunner; target.loadSources = loadSources;
    return target;
}
// Runtime layer is dev-mode only: with no reachable detection from the sandbox,
// run_tests computes dev_mode in 160-run-tests.js and passes it to run({dev_mode}).

module.exports = {
    assert: assert, AssertionError: AssertionError, describe: describe, test: test, beforeEach: beforeEach, afterEach: afterEach,
    reset: reset, run: run, skip: skip, install: install,
    scratchPath: scratchPath, isScratchPath: isScratchPath, snapshotDirty: snapshotDirty, snapshotDirtyState: snapshotDirtyState, fingerprint: fingerprint, checkIsolation: checkIsolation,
    cleanupScratch: cleanupScratch, heartbeat: heartbeat, fakeChrome: fakeChrome, fakeWindow: fakeWindow,
    toolDecision: toolDecision, installToolGuard: installToolGuard,
    registerRunner: registerRunner, loadSources: loadSources,
    _isDeepEqual: _hIsDeepEqual, _matchesExpected: _hMatchesExpected, _state: _hState,
    DEFAULT_TIMEOUT_MS: HARNESS_DEFAULT_TIMEOUT_MS, AFTER_TIMEOUT_MS: HARNESS_AFTER_TIMEOUT_MS, SCRATCH_PREFIX: HARNESS_SCRATCH_PREFIX
};
