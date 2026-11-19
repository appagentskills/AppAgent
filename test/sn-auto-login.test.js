// connect_instance: credential login (background.js snAutoLogin) + password
// redaction helpers (agent loop, message render, SW approval rows). Evaluates the
// REAL source functions (extracted by name) against fake chrome tabs/scripting/
// storage. The password must never reach chrome.storage, results or masks.

var EX = await runFile('test/extract.js', { i18n: false });
function extractFn(src, name) {
    var f = EX.findFunction(src, name);
    if (!f) throw new Error('function not found: ' + name);
    if (!(f.end > f.start)) throw new Error('unbalanced: ' + name);
    return src.slice(f.start, f.end);
}

var O = 'https://dev1.service-now.com';
var PW = 'S3cr3t"pw\\x';

var LOGIN_FNS = ['snTimeoutMs', 'snWithTimeout', 'snInjectBounded', 'snAutoLoginId', 'snAutoLoginFailState', 'snLoginFillAndSubmit', 'snLoginProbeState', 'snLoginLooksSignedIn',
    'snAutoLoginHardCapMs', 'snSettleWithin', 'snAutoLoginSleep', 'snAutoLogin', 'snAutoLoginRun', 'snAutoLoginActivate', 'snSetActiveInstance'];

// world: { tabs: [{id,url,status}], have: {token,userName}|null, instanceUrl,
//          probe: function(ctx) -> state, fillResult, session: shared session store }
async function build(world) {
    var src = await loadFile('src/platform/extension/background.js');
    var store = { instanceUrl: world.instanceUrl };
    var session = world.session || (world.session = {});
    var log = { sets: [], sessionSets: [], removed: [], updated: [], created: [], fills: [], remembered: [], probes: 0 };
    var ctx = { submitted: false, n: 0 };
    var nextId = 100;
    var chrome = {
        tabs: {
            query: async function() { return world.tabs.map(function(t) { return Object.assign({}, t); }); },
            update: async function(id, o) { log.updated.push({ id: id, url: o.url }); var t = world.tabs.filter(function(x) { return x.id === id; })[0]; if (t) { t.url = o.url; t.status = 'complete'; } return t; },
            create: async function(o) { var t = { id: nextId++, url: o.url, status: 'complete', active: o.active }; world.tabs.push(t); log.created.push(t); return t; },
            get: async function(id) { var t = world.tabs.filter(function(x) { return x.id === id; })[0]; if (!t) throw new Error('No tab'); return Object.assign({}, t, world.tabOverride ? world.tabOverride(ctx) : {}); },
            remove: async function(id) { log.removed.push(id); world.tabs = world.tabs.filter(function(x) { return x.id !== id; }); }
        },
        scripting: { executeScript: async function(o) {
            if (o.func && o.func.name === 'snLoginFillAndSubmit') {
                log.fills.push({ tabId: o.target.tabId, args: o.args });
                ctx.submitted = true;
                return [{ result: world.fillResult || { submitted: true, via: 'click' } }];
            }
            log.probes++; ctx.n++;
            // navStart: page loaded after the submit once submitted (overridable by the probe).
            return [{ result: Object.assign({ navStart: ctx.submitted ? Date.now() + 1 : 1 }, world.probe(ctx)) }];
        } },
        storage: {
            local: {
                get: function(k, cb) { var o = {}; o[k] = store[k]; if (cb) setTimeout(function() { cb(o); }, 0); return Promise.resolve(o); },
                set: function(o) { log.sets.push(JSON.parse(JSON.stringify(o))); Object.assign(store, JSON.parse(JSON.stringify(o))); }
            },
            session: world.noSession ? undefined : {
                get: async function(k) { var o = {}; if (session[k] !== undefined) o[k] = JSON.parse(JSON.stringify(session[k])); return o; },
                set: async function(o) { log.sessionSets.push(JSON.parse(JSON.stringify(o))); Object.assign(session, JSON.parse(JSON.stringify(o))); }
            }
        }
    };
    var snGetTokenForInstance = async function() { return world.have || { token: '', error: 'No open tab' }; };
    var snRememberInstanceToken = async function(origin, token, user) { log.remembered.push([origin, token, user]); };
    var body = 'var _snAutoLoginInflight = {}; var _snAutoLoginOriginTail = {}; var _snAutoLoginFailsMem = {}; var _snAutoLoginFailsTail = null;\n' +
        'var SN_AUTO_LOGIN_PAUSE_MS = 600000; var SN_AUTO_LOGIN_MAX_FAILS = 2; var SN_AUTO_LOGIN_FAILS_KEY = "snAutoLoginFails";\n' +
        LOGIN_FNS.map(function(n) { return extractFn(src, n); }).join('\n') +
        '\nreturn { login: snAutoLogin, id: snAutoLoginId, fails: snAutoLoginFailState, signedIn: snLoginLooksSignedIn, mem: function() { return _snAutoLoginFailsMem; } };';
    var api = new Function('chrome', 'snGetTokenForInstance', 'snRememberInstanceToken', body)(chrome, snGetTokenForInstance, snRememberInstanceToken);
    api.store = store; api.log = log; api.world = world; api.session = session;
    return api;
}

// FAST: tests expecting a NON-timeout outcome return as soon as the probe
// settles, so a generous timeout only matters under shard load (60 ms flaked
// with 4 shards). SHORT: only for tests that EXPECT reason 'timeout'.
var FAST = { pollMs: 1, timeoutMs: 5000 };
var SHORT = { pollMs: 1, timeoutMs: 60 };
var CREDS = { username: 'admin', password: PW };
function formState() { return { token: 'pre', userName: 'guest', path: '/login.do', hasLoginForm: true, mfa: false, pwChange: false, errText: '' }; }
function okState() { return { token: 'tok-live', userName: 'admin', path: '/navpage.do', hasLoginForm: false, mfa: false, pwChange: false, errText: '' }; }
function badProbe(c) { var s = formState(); if (c.submitted) s.errText = 'User name or password invalid'; return s; }
function noLeak(api, res) {
    var blob = JSON.stringify(api.log.sets) + JSON.stringify(api.store) + JSON.stringify(res) + JSON.stringify(api.session) +
        JSON.stringify(api.log.sessionSets) + JSON.stringify(api.mem()) + JSON.stringify(api.log.remembered);
    assert.ok(blob.indexOf('S3cr3t') === -1, 'password leaked: ' + blob.slice(0, 200));
}

describe('snAutoLogin (connect_instance)', function() {
    test('success: opens a background tab, fills, stores token + activates; never stores the password', async function() {
        var a = await build({ tabs: [], probe: function(c) { return c.submitted ? okState() : formState(); } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.strictEqual(r.instance, O);
        assert.strictEqual(r.userName, 'admin');
        assert.strictEqual(a.log.created.length, 1);
        assert.strictEqual(a.log.created[0].active, false);
        assert.strictEqual(a.log.created[0].url, O + '/login.do');
        assert.strictEqual(a.log.fills.length, 1);
        assert.deepStrictEqual(a.log.fills[0].args, ['admin', PW]);
        assert.deepStrictEqual(a.log.remembered[0], [O, 'tok-live', 'admin']);
        await sleep(5);
        assert.strictEqual(a.store.instanceUrl, O);
        assert.strictEqual(a.store.sessionToken, 'tok-live');
        assert.strictEqual(a.log.removed.length, 0, 'success keeps the session tab');
        noLeak(a, r);
    });

    test('already connected: no tab work, returns alreadyConnected (flags a different user)', async function() {
        var a = await build({ tabs: [], have: { token: 'existing', userName: 'bob', tabId: 7 }, probe: formState });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.alreadyConnected, true);
        assert.strictEqual(r.userMismatch, true);
        assert.strictEqual(a.log.created.length + a.log.updated.length + a.log.fills.length, 0);
    });

    test('does not override an already-active different instance', async function() {
        var a = await build({ tabs: [], instanceUrl: 'https://other.service-now.com', probe: function(c) { return c.submitted ? okState() : formState(); } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.success, true);
        await sleep(5);
        assert.strictEqual(a.store.instanceUrl, 'https://other.service-now.com');
        assert.strictEqual(a.log.sets.length, 0);
    });

    test('lockout: 1st bad_credentials not paused, 2nd consecutive pauses 10 min (per user, no password stored)', async function() {
        var a = await build({ tabs: [], probe: badProbe });
        var r1 = await a.login(O, CREDS, FAST);
        assert.strictEqual(r1.reason, 'bad_credentials');
        assert.deepStrictEqual(a.log.removed, [a.log.created[0].id], 'closes only the tab it opened');
        var r2 = await a.login(O, { username: 'admin', password: 'other' }, FAST);
        assert.strictEqual(r2.reason, 'bad_credentials', 'second attempt still runs');
        var r3 = await a.login(O, CREDS, FAST);
        assert.strictEqual(r3.reason, 'paused');
        assert.strictEqual(a.log.fills.length, 2, 'no submit while paused');
        var st = a.session.snAutoLoginFails[O + '|admin'];
        assert.strictEqual(st.count, 2);
        assert.ok(st.until - Date.now() > 9 * 60000 && st.until - Date.now() <= 600000);
        assert.deepStrictEqual(Object.keys(st).sort(), ['count', 'until'], 'no password / hash field');
        var r4 = await a.login(O, { username: 'other.user', password: 'x' }, FAST);
        assert.notStrictEqual(r4.reason, 'paused', 'other users are not paused');
        noLeak(a, r1); noLeak(a, r3);
    });

    test('lockout counter survives a SW restart (chrome.storage.session) and success resets it', async function() {
        var shared = {};
        var a = await build({ tabs: [], probe: badProbe, session: shared });
        await a.login(O, CREDS, FAST);
        var b = await build({ tabs: [], probe: function(c) { return c.submitted ? okState() : formState(); }, session: shared });
        assert.strictEqual((await b.fails(O + '|admin')).count, 1, 'count persisted across instances');
        var ok = await b.login(O, CREDS, FAST);
        assert.strictEqual(ok.success, true);
        assert.strictEqual(await b.fails(O + '|admin'), null, 'success resets');
        var c = await build({ tabs: [], probe: badProbe, session: shared });
        await c.login(O, CREDS, FAST); await c.login(O, CREDS, FAST);
        var d = await build({ tabs: [], probe: badProbe, session: shared });
        assert.strictEqual((await d.login(O, CREDS, FAST)).reason, 'paused', 'pause survives restart');
    });

    test('expired pause starts fresh; in-memory fallback without storage.session', async function() {
        var a = await build({ tabs: [], probe: badProbe, session: { snAutoLoginFails: {} } });
        a.session.snAutoLoginFails[O + '|admin'] = { count: 2, until: Date.now() - 1 };
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'bad_credentials');
        assert.strictEqual(a.session.snAutoLoginFails[O + '|admin'].count, 1);
        var m = await build({ tabs: [], probe: badProbe, noSession: true });
        await m.login(O, CREDS, FAST); await m.login(O, CREDS, FAST);
        assert.strictEqual((await m.login(O, CREDS, FAST)).reason, 'paused');
        assert.strictEqual(m.mem()[O + '|admin'].count, 2);
    });

    test('mfa: reason mfa_required', async function() {
        var a = await build({ tabs: [], probe: function(c) { var s = formState(); if (c.submitted) { s.hasLoginForm = false; s.mfa = true; s.token = ''; } return s; } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'mfa_required');
        assert.strictEqual(a.log.removed.length, 1);
    });

    test('mfa page WITH g_ck is not a success', async function() {
        var a = await build({ tabs: [], probe: function(c) { return c.submitted ? { token: 'tok-mfa', userName: '', path: '/validate_multifactor_auth_code.do', hasLoginForm: false, mfa: true, pwChange: false, errText: '' } : formState(); } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.reason, 'mfa_required');
        assert.strictEqual(a.log.remembered.length, 0);
    });

    test('password-change page WITH g_ck: reason password_change_required, not success', async function() {
        var a = await build({ tabs: [], probe: function(c) { return c.submitted ? { token: 'tok-pw', userName: 'admin', path: '/login.do', hasLoginForm: false, mfa: false, pwChange: true, errText: '' } : formState(); } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'password_change_required');
        assert.strictEqual(a.log.remembered.length, 0);
    });

    test('signed-in evidence requires a non-login path and a token', async function() {
        var a = await build({ tabs: [], probe: formState });
        assert.strictEqual(a.signedIn(okState()), true);
        assert.strictEqual(a.signedIn(Object.assign(okState(), { token: '' })), false);
        assert.strictEqual(a.signedIn(Object.assign(okState(), { path: '/login.do' })), false);
        assert.strictEqual(a.signedIn(Object.assign(okState(), { path: '/validate_multifactor_auth_code.do' })), false);
        assert.strictEqual(a.signedIn(Object.assign(okState(), { path: '/change_password.do' })), false);
    });

    test('stale login error (no navigation after submit) is not classified bad_credentials', async function() {
        var a = await build({ tabs: [], fillResult: { submitted: true }, probe: function(c) { var s = formState(); s.errText = 'User name or password invalid'; s.navStart = 1; return s; } });
        var r = await a.login(O, CREDS, SHORT);
        assert.strictEqual(r.reason, 'timeout');
        assert.strictEqual(await a.fails(O + '|admin'), null, 'not counted');
    });

    test('sso redirect to another origin: reason sso_redirect, no fill', async function() {
        var a = await build({ tabs: [], probe: formState, tabOverride: function() { return { url: 'https://login.microsoftonline.com/x' }; } });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'sso_redirect');
        assert.strictEqual(a.log.fills.length, 0);
    });

    test('timeout when no session ever appears; not counted', async function() {
        var a = await build({ tabs: [], probe: formState, fillResult: { submitted: true } });
        var r = await a.login(O, CREDS, SHORT);
        assert.strictEqual(r.reason, 'timeout');
        assert.strictEqual(await a.fails(O + '|admin'), null);
        noLeak(a, r);
    });

    test('never navigates a user tab of the origin: opens a new background tab and closes only that one', async function() {
        var a = await build({ tabs: [{ id: 5, url: O + '/incident_list.do', status: 'complete' }], probe: badProbe });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'bad_credentials');
        assert.strictEqual(a.log.updated.length, 0, 'user tab untouched');
        assert.strictEqual(a.log.created.length, 1);
        assert.deepStrictEqual(a.log.removed, [a.log.created[0].id]);
    });

    test('reuses a tab already on login.do and never closes it', async function() {
        var a = await build({ tabs: [{ id: 6, url: O + '/login.do', status: 'complete' }], probe: badProbe });
        var r = await a.login(O, CREDS, FAST);
        assert.strictEqual(r.reason, 'bad_credentials');
        assert.strictEqual(a.log.created.length + a.log.updated.length, 0);
        assert.strictEqual(a.log.fills[0].tabId, 6);
        assert.strictEqual(a.log.removed.length, 0);
    });

    test('single-flight per origin+username', async function() {
        var a = await build({ tabs: [], probe: function(c) { return c.submitted && c.n > 3 ? okState() : formState(); } });
        var OKT = { pollMs: 1, timeoutMs: 3000 };   // success returns early; generous under shard load
        var res = await Promise.all([a.login(O, CREDS, OKT), a.login(O, CREDS, OKT)]);
        assert.strictEqual(res[0].success, true);
        assert.strictEqual(res[1].success, true);
        assert.strictEqual(a.log.created.length, 1);
        assert.strictEqual(a.log.fills.length, 1);
    });

    test('different user on the same origin waits for the running login, then runs', async function() {
        var a = await build({ tabs: [], fillResult: { submitted: true }, probe: formState });
        var order = [];
        var p1 = a.login(O, CREDS, SHORT).then(function(r) { order.push('admin:' + r.reason); return r; });
        var p2 = a.login(O, { username: 'bob', password: 'pw2' }, SHORT).then(function(r) { order.push('bob:' + r.reason); return r; });
        await Promise.all([p1, p2]);
        assert.deepStrictEqual(order, ['admin:timeout', 'bob:timeout']);
        assert.strictEqual(a.log.fills.length, 2, 'both ran');
        assert.deepStrictEqual(a.log.fills.map(function(f) { return f.args[0]; }), ['admin', 'bob']);
    });

    test('rejects non-https origin and missing credentials', async function() {
        var a = await build({ tabs: [], probe: formState });
        assert.strictEqual((await a.login('http://x.service-now.com', CREDS, FAST)).reason, 'invalid_instance');
        assert.strictEqual((await a.login(O, { username: 'a' }, FAST)).reason, 'missing_credentials');
    });

    test('failure key is origin|username only', async function() {
        var a = await build({ tabs: [], probe: formState });
        assert.strictEqual(a.id(O, 'Admin'), O + '|admin');
    });
});

describe('secret tool-arg redaction', function() {
    var M;
    beforeEach(async function() {
        if (M) return;
        var loop = await loadFile('src/js/app/030-agent-loop.js');
        var render = await loadFile('src/js/ui/250-message-render.js');
        var routing = await loadFile('src/js/worker/120-tool-routing.js');
        var body = 'var _secretToolArgs = {}; var SECRET_ARG_KEY_RE = /^(password|passwd|secret)$/i; var SECRET_REDACT_TOOLS = { connect_instance: true };\n' +
            ['_isSecretRedactedTool', '_redactedSecretArgError', '_maskSecretValuesInTurn', '_secretValuesFromRaw', '_maskSecretArgString', '_redactSecretArgsObject',
                '_redactSecretToolCalls', '_maskStreamingToolCalls', '_takeSecretToolArgs', '_toolArgsParseErrorMessage'].map(function(n) { return extractFn(loop, n); }).join('\n') +
            '\n' + extractFn(render, 'maskSecretToolArgs') + '\n' + extractFn(routing, '_swRedactApprovalArgs') +
            '\nreturn { mask: _maskSecretArgString, obj: _redactSecretArgsObject, redact: _redactSecretToolCalls, stream: _maskStreamingToolCalls, take: _takeSecretToolArgs, ui: maskSecretToolArgs, approval: _swRedactApprovalArgs, guard: _redactedSecretArgError, turn: _maskSecretValuesInTurn, parseMsg: _toolArgsParseErrorMessage };';
        M = new Function(body)();
    });

    var FULL = JSON.stringify({ instance: 'dev1', username: 'admin', password: PW });

    test('full JSON is masked and still parses (loop + render identical)', function() {
        [M.mask, M.ui].forEach(function(f) {
            var out = f(FULL);
            assert.ok(out.indexOf('S3cr3t') === -1, out);
            var p = JSON.parse(out);
            assert.strictEqual(p.password, '[redacted]');
            assert.strictEqual(p.username, 'admin');
        });
    });

    test('partial (streaming) JSON is masked, including a trailing backslash', function() {
        var partials = ['{"username":"a","password":"S3cr', '{"password": "S3cr3t\\', '{"password":"S3cr3t\\\"pw'];
        partials.forEach(function(s) {
            assert.ok(M.mask(s).indexOf('S3cr') === -1, M.mask(s));
            assert.ok(M.ui(s).indexOf('S3cr') === -1, M.ui(s));
        });
    });

    test('non-secret args unchanged (same reference)', function() {
        var s = '{"table":"incident","passcode_hint":"x"}';
        assert.strictEqual(M.mask(s), s);
        assert.strictEqual(M.ui(s), s);
    });

    test('redactSecretToolCalls rewrites connect_instance in place and take() returns raw once', function() {
        var calls = [{ id: 'c1', function: { name: 'connect_instance', arguments: FULL } }, { id: 'c2', function: { name: 'x', arguments: '{}' } }];
        assert.strictEqual(M.redact(calls), 1);
        assert.ok(calls[0].function.arguments.indexOf('S3cr3t') === -1);
        assert.strictEqual(M.take(calls[0]), FULL);
        assert.strictEqual(M.take(calls[0]), null);
        assert.strictEqual(M.take(calls[1]), null);
    });

    test('other tools keep literal password args (persisted + streaming)', function() {
        var sn = JSON.stringify({ method: 'POST', table: 'basic_auth_credentials', data: { name: 'x', password: 'real-pw' } });
        var calls = [{ id: 's1', function: { name: 'servicenow_api', arguments: sn } }];
        assert.strictEqual(M.redact(calls), 0);
        assert.strictEqual(calls[0].function.arguments, sn);
        assert.strictEqual(M.take(calls[0]), null);
        assert.strictEqual(M.stream(calls), calls);
    });

    test('fail-closed guard: "[redacted]" as a secret value refuses execution (any depth)', function() {
        assert.match(M.guard('servicenow_api', { data: { password: '[redacted]' } }), /Refused to run servicenow_api.*password/);
        assert.match(M.guard('x', { secret: '[redacted]' }), /secret/);
        assert.strictEqual(M.guard('servicenow_api', { data: { password: 'real' } }), null);
        assert.strictEqual(M.guard('x', { note: '[redacted]' }), null);
    });

    test('the exact password is masked in thinking / content / reasoning_details of the turn', function() {
        var msg = { content: 'logging in with ' + PW, thinking: 'user said pw is ' + PW,
            reasoning_details: [{ type: 'reasoning.text', text: 'json ' + JSON.stringify(PW) + ' and ' + PW, signature: 'sig' + PW.length }] };
        var calls = [{ id: 'c9', function: { name: 'connect_instance', arguments: FULL } }];
        M.redact(calls, msg);
        var blob = JSON.stringify(msg);
        assert.ok(blob.indexOf('S3cr3t') === -1, blob);
        assert.ok(msg.thinking.indexOf('[redacted]') !== -1);
        assert.strictEqual(msg.reasoning_details[0].signature, 'sig' + PW.length, 'opaque signature untouched');
        M.take(calls[0]);
    });

    test('connect_instance parse errors report the length only', function() {
        var raw = '{"password":"S3cr3t-oops';
        var err; try { JSON.parse(raw); } catch (e) { err = e; }
        var m = M.parseMsg(raw, err, 'connect_instance');
        assert.ok(m.indexOf('S3cr3t') === -1, m);
        assert.match(m, new RegExp(String(raw.length) + ' chars'));
        assert.match(M.parseMsg('{"a":', err, 'other'), /^Invalid tool arguments: /);
    });

    test('streaming copy masks without mutating the source', function() {
        var calls = [{ id: 'c1', function: { name: 'connect_instance', arguments: FULL } }];
        var view = M.stream(calls);
        assert.notStrictEqual(view, calls);
        assert.ok(view[0].function.arguments.indexOf('S3cr3t') === -1);
        assert.strictEqual(calls[0].function.arguments, FULL);
    });

    test('object redaction (loop + approval rows)', function() {
        [M.obj, M.approval].forEach(function(f) {
            var a = { instance: 'dev1', password: PW };
            var r = f(a);
            assert.strictEqual(r.password, '[redacted]');
            assert.strictEqual(a.password, PW, 'input not mutated');
            var plain = { table: 'x' };
            assert.strictEqual(f(plain), plain);
        });
    });
});
