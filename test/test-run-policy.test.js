// Executable host-boundary checks. All frames, clocks, Chrome APIs and dispatch
// bridges are fakes. Never sends a live tool message or runs workspace test code.
async function runTestRunPolicyTests(sources) {
    var passed = [];
    function check(name, yes) { if (!yes) throw new Error(name); passed.push(name); }
    function cut(text, start, end) { var a = text.indexOf(start), b = text.indexOf(end, a); if (a < 0 || b < 0) throw new Error('Missing extraction marker: ' + start); return text.slice(a, b); }
    async function flush() { for (var i = 0; i < 20; i++) await Promise.resolve(); }
    async function rejects(name, fn) { var rejected = false; try { await fn(); } catch (_) { rejected = true; } check(name, rejected); }
    function realm() {
        var now = 1000, timers = new Map(), seq = 0, listeners = new Set(), frames = [], calls = [], removed = 0;
        function setTimer(fn, ms) { var id = ++seq; timers.set(id, { fn: fn, at: now + ms }); return id; }
        function clearTimer(id) { timers.delete(id); }
        var P = new Function('Date', 'setTimeout', 'clearTimeout', sources['src/js/core/075-test-run-policy.js'] + '\nreturn TestRunPolicy;')({ now: function() { return now; } }, setTimer, clearTimer);
        var window = { addEventListener: function(_, f) { listeners.add(f); }, removeEventListener: function(_, f) { listeners.delete(f); } };
        var body = { appendChild: function(f) { f.parentNode = body; }, removeChild: function(f) { f.parentNode = null; removed++; } };
        var document = { body: body, createElement: function() { var f = { style: {}, events: {}, sent: [], parentNode: null }; f.addEventListener = function(t, fn) { f.events[t] = fn; }; f.removeEventListener = function(t) { delete f.events[t]; }; f.contentWindow = { postMessage: function(m) { f.sent.push(m); } }; frames.push(f); return f; } };
        function emit(f, data, source) { Array.from(listeners).forEach(function(fn) { fn({ source: source || f.contentWindow, data: data }); }); }
        return { P: P, document: document, window: window, frames: frames, calls: calls, emit: emit,
            setTimer: setTimer, clearTimer: clearTimer, clock: { now: function() { return now; } },
            advance: function(ms) { now += ms; Array.from(timers.entries()).forEach(function(e) { if (e[1].at <= now) { timers.delete(e[0]); e[1].fn(); } }); },
            removed: function() { return removed; }, listeners: listeners,
            key: function() { return P.registry.open({ workspace: 'owner/repo::main', deadline: now + 10000 }); },
            dispatch: function(name, args) { calls.push({ name: name, args: args }); return Promise.resolve({ success: true, content: 'safe source' }); }
        };
    }
    var h = realm(), P = h.P, key = h.key();
    check('default source reads pin selected workspace', P.registry.gate(key, 'run_js_file', { path: 'src/a.js', mode: 'source' }).args.workspace === 'owner/repo::main');
    for (var name of ['js_eval', 'run_tests', 'get_cookie', 'web_fetch', 'servicenow_api', 'document']) check('deny tool ' + name, !P.registry.gate(key, name, {}).ok);
    for (var mode of ['module', 'script', undefined]) check('deny nested run_js_file ' + mode, !P.registry.gate(key, 'run_js_file', { path: 'src/a.js', mode: mode }).ok);
    check('foreign workspace rejected', !P.registry.gate(key, 'run_js_file', { path: 'src/a.js', mode: 'source', workspace: 'foreign/repo::main' }).ok);
    for (var action of ['write', 'edit', 'delete', 'copy', 'discard', 'push', 'branch', 'move', 'clone', 'pin', 'hydrate']) check('deny all mutation action ' + action, !P.registry.gate(key, 'workspace', { action: action, path: 'test/.scratch/a', dest: 'test/.scratch/b' }).ok);
    for (var args of [{ action: 'discard' }, { action: 'discard', files: ['test/.scratch/a'] }, { action: 'discard', dest: 'test/.scratch/a' }, { action: 'copy', path: 'test/.scratch/a' }, { action: 'discard', path: 'test/.scratch/../a' }, { action: 'read', path: 'a', force: false }]) check('reject malformed selector ' + JSON.stringify(args), !P.registry.gate(key, 'workspace', args).ok);
    for (var path of ['../a', '/a', 'a/../b', 'a//b', 'a\\b', 'a/./b']) check('reject noncanonical source ' + path, !P.registry.gate(key, 'run_js_file', { path: path, mode: 'source' }).ok);
    var sleepKey = h.key();
    var sleepDecision = P.registry.gate(sleepKey, '__sandbox_sleep', { ms: 30000 });
    check('sleep clamps to remaining host budget without a denial', sleepDecision.ok && sleepDecision.args.ms === 10000 && P.registry.denials(sleepKey).length === 0);
    for (var ms of [-1, NaN, Infinity, '10']) check('invalid sleep rejected ' + String(ms), !P.registry.gate(sleepKey, '__sandbox_sleep', { ms: ms }).ok);
    var mutableGrant = { name: 'workspace', actions: ['status'] };
    var immutableKey = P.registry.open({ workspace: 'owner/repo::main', deadline: 11000, allow_tools: [mutableGrant] });
    mutableGrant.actions.push('push'); mutableGrant.name = 'get_cookie';
    check('caller grant mutation cannot change host config', !P.registry.gate(immutableKey, 'workspace', { action: 'push' }).ok && Object.isFrozen(P.registry.descriptor(immutableKey).allow_tools[0].actions));
    check('status requires top-level opt-in', !P.registry.gate(key, 'workspace', { action: 'status' }).ok);
    var granted = P.registry.open({ workspace: 'owner/repo::main', deadline: 11000, allow_tools: [{ name: 'workspace', actions: ['status', 'diff'] }] });
    check('constrained status grant works', P.registry.gate(granted, 'workspace', { action: 'status' }).ok);
    await rejects('legacy blanket grant rejected', function() { P.grants(['workspace']); });
    await rejects('mutation grant rejected', function() { P.grants([{ name: 'workspace', actions: ['push'] }]); });
    check('unknown context fails closed', !P.registry.gate({}, 'run_js_file', { mode: 'source', path: 'a' }).ok);
    P.registry.bind('test-id', key); P.registry.bind('general-id', null);
    check('general invocation compatibility', P.registry.relay('general-id', 'workspace', { action: 'write' }).ok);
    check('forged invocation cannot downgrade', !P.registry.relay('forged', 'workspace', { action: 'write' }).ok);
    P.registry.unbind('test-id');
    check('revoked context fails closed', !P.registry.gate(key, 'run_js_file', { mode: 'source', path: 'a' }).ok);
    check('revoked invocation fails closed', !P.registry.relay('test-id', 'workspace', { action: 'write' }).ok);
    await rejects('recycled invocation rejected', function() { P.registry.bind('test-id', null); });
    check('worker restart cannot downgrade test id', !P.createRegistry().relay('test-id', 'workspace', { action: 'write' }).ok);
    // B12: tombstone cap — oldest INACTIVE entries age out at 500, active bindings survive, evicted ids stay denied.
    var capReg = P.createRegistry();
    capReg.bind('live-0', null);
    for (var ci = 1; ci <= 520; ci++) { capReg.bind('t-' + ci, null); capReg.unbind('t-' + ci); }
    check('registry capped at 500 entries', capReg.size() === 500);
    check('active binding never evicted', capReg.relay('live-0', 'workspace', { action: 'read' }).ok === true);
    check('evicted tombstone still denied (unknown)', !capReg.relay('t-1', 'workspace', { action: 'read' }).ok);
    check('surviving tombstone still denied (revoked)', !capReg.relay('t-520', 'workspace', { action: 'read' }).ok);
    await rejects('surviving tombstone still not recyclable', function() { capReg.bind('t-520', null); });
    key = h.key(); h.advance(10001);
    check('absolute deadline fails closed', !P.registry.gate(key, 'run_js_file', { mode: 'source', path: 'a' }).ok);

    // The actual shared page/offscreen frame handler, with no harness at all.
    h = realm(); P = h.P; key = h.key();
    var run = P.runFrame({ registry: P.registry, context: key, document: h.document, window: h.window, code: 'not executed by fake frame', dispatch: h.dispatch });
    var frame = h.frames[0];
    h.emit(frame, { type: 'sandboxReady' }, {}); check('foreign frame ignored', frame.sent.length === 0);
    h.emit(frame, { type: 'sandboxReady' }); h.emit(frame, { type: 'sandboxReady' }); check('test ready executes once', frame.sent.length === 1);
    for (var call of [{ name: 'workspace', args: { action: 'write', path: 'test/.scratch/a' } }, { name: 'workspace', args: { action: 'push' } }, { name: 'get_cookie', args: {} }, { name: 'run_js_file', args: { path: 'src/a.js', mode: 'module' } }]) h.emit(frame, Object.assign({ type: 'sandboxToolCall', id: 1, testRunPolicy: null, sandboxRequestId: 'general-id' }, call));
    await flush(); check('raw messages cannot dispatch writes/push/cookies/nested execution', h.calls.length === 0 && frame.sent.filter(function(m) { return m.result && m.result.denied_by_host; }).length === 4);
    var initialDenials = 4;
    for (var attack of [
        { name: 'js_eval', args: { code: 'mutate()' } },
        { name: 'run_tests', args: { allow_tools: [{ name: 'workspace', actions: ['push'] }] } },
        { name: 'run_js_file', args: { path: 'a', mode: 'script' } },
        { name: 'run_js_file', args: { path: 'a', mode: 'source', workspace: 'foreign' } },
        { name: 'workspace', args: { action: 'status', allow_tools: [{ name: 'workspace', actions: ['status'] }] } },
        { name: 'workspace', args: { action: 'discard', files: ['test/.scratch/a'] } },
        { name: 'workspace', args: { action: 'discard', dest: 'test/.scratch/a' } },
        { name: 'workspace', args: { action: 'discard' } }
    ]) { h.emit(frame, Object.assign({ type: 'sandboxToolCall', id: 100 + initialDenials++, testRunPolicy: { allow_tools: ['workspace'] }, sandboxRequestId: 'general-id' }, attack)); }
    await flush(); check('wrapper-free raw attacks cannot grant privileges or reach global discard', h.calls.length === 0 && P.registry.denials(key).length === initialDenials);
    h.emit(frame, { type: 'sandboxToolCall', id: 2, name: 'run_js_file', args: { path: 'src/a.js', mode: 'source' } }); await flush();
    check('safe source read survives real frame ingress', h.calls.length === 1 && h.calls[0].args.workspace === 'owner/repo::main');
    h.emit(frame, { type: 'sandboxDone', result: { success: true, denied_calls: [], isolation: { ok: true } } });
    var done = await run;
    check('forged success cannot erase host denials', done.denied_calls.length === initialDenials);
    check('completion destroys exact frame and revokes authority', h.removed() === 1 && h.listeners.size === 0 && !P.registry.gate(key, 'run_js_file', { mode: 'source', path: 'a' }).ok);
    h.emit(frame, { type: 'sandboxToolCall', name: 'workspace', args: { action: 'write' } }); await flush(); check('late messages after completion do nothing', h.calls.length === 1);

    for (var termination of ['deadline', 'per-test', 'abort', 'error']) {
        h = realm(); P = h.P; key = h.key(); var controller = new AbortController();
        var ended = P.runFrame({ registry: P.registry, context: key, document: h.document, window: h.window, code: '', dispatch: h.dispatch, signal: controller.signal }).then(function() { return false; }, function() { return true; });
        frame = h.frames[0];
        if (termination === 'deadline') h.advance(10001);
        if (termination === 'per-test') h.emit(frame, { type: 'sandboxTestTimeout' });
        if (termination === 'abort') controller.abort();
        if (termination === 'error') frame.events.error();
        check(termination + ' destroys and revokes exact frame', await ended && h.removed() === 1 && !P.registry.gate(key, 'run_js_file', { path: 'a', mode: 'source' }).ok);
    }
    h = realm(); P = h.P; key = h.key();
    run = P.runFrame({ registry: P.registry, context: key, document: h.document, window: h.window, code: '', dispatch: h.dispatch }); frame = h.frames[0];
    h.emit(frame, { type: 'sandboxToolCall', id: 1, name: 'run_js_file', args: { path: 'a', mode: 'source' } });
    h.emit(frame, { type: 'sandboxDone', result: {} }); await run; await flush();
    check('forged early completion cancels queued bridge dispatch', h.calls.length === 0 && h.removed() === 1);

    for (var failAt of ['sandboxReady', 'sandboxToolCall']) {
        h = realm(); P = h.P; key = h.key();
        var postFailure = P.runFrame({ registry: P.registry, context: key, document: h.document, window: h.window, code: '', dispatch: h.dispatch }).then(function() { return false; }, function(e) { return /post failure/.test(e.message); });
        frame = h.frames[0]; frame.contentWindow.postMessage = function() { throw new Error('post failure'); };
        h.emit(frame, { type: failAt, name: 'get_cookie', args: {}, id: 1 });
        check(failAt + ' post failure destroys frame and revokes', await postFailure && h.removed() === 1 && h.listeners.size === 0 && !P.registry.gate(key, 'workspace', { action: 'ls' }).ok);
    }
    h = realm(); P = h.P; var first = h.key(), second = h.key();
    var r1 = P.runFrame({ registry: P.registry, context: first, document: h.document, window: h.window, code: '', dispatch: h.dispatch });
    var r2 = P.runFrame({ registry: P.registry, context: second, document: h.document, window: h.window, code: '', dispatch: h.dispatch });
    h.emit(h.frames[0], { type: 'sandboxDone', result: {} }); await r1;
    check('test completion removes only its exact frame and context', h.removed() === 1 && h.listeners.size === 1 && P.registry.gate(second, 'workspace', { action: 'ls' }).ok);
    h.emit(h.frames[1], { type: 'sandboxDone', result: {} }); await r2;
    check('sibling test completes and cleans separately', h.removed() === 2 && h.listeners.size === 0);

    // Execute the page test arm itself; its host options must reach the same
    // exact-frame handler rather than falling through to unrestricted js_eval.
    h = realm(); key = h.key();
    var pageArm = cut(sources['src/js/tools/020-tool-execution.js'], '            var _testKey = options && options._testRunContext;', '            // SW context bridges js_eval');
    var PageFunction = Object.getPrototypeOf(async function() {}).constructor;
    var pageRun = new PageFunction('options', 'Platform', 'TestRunPolicy', 'args', 'document', 'window', 'chatId', 'messageIndex', 'executeTool', pageArm);
    var pageResult = pageRun({ _testRunContext: key }, { isWorker: false }, h.P, { code: '' }, h.document, h.window, 'chat', 0, h.dispatch);
    frame = h.frames[0];
    h.emit(frame, { type: 'sandboxToolCall', id: 1, name: 'get_cookie', args: {} });
    h.emit(frame, { type: 'sandboxToolCall', id: 2, name: 'run_js_file', args: { path: 'a', mode: 'source' } }); await flush();
    h.emit(frame, { type: 'sandboxDone', result: {} });
    check('real page ingress denies cookies and forwards only pinned source reads', (await pageResult).result.denied_calls.length === 1 && h.calls.length === 1 && h.calls[0].args.workspace === 'owner/repo::main');
    check('non-test page invocation falls through unchanged', await pageRun({}, { isWorker: false }, h.P, {}, h.document, h.window, 'chat', 0, h.dispatch) === undefined);

    // Execute the host transport binding, stripping caller-supplied descriptors.
    var startupSource = cut(sources['src/platform/extension/background.js'], 'function swTestPolicyStartupError()', '// Called by the SW runtime');
    var transportSource = startupSource + cut(sources['src/platform/extension/background.js'], 'async function callOffscreenHelper(', '// Expose to the imported SW bundle.');
    h = realm(); key = h.key(); var wire, sequence = 0;
    var transport = new Function('waitForOffscreenReady', 'chrome', 'crypto', 'TestRunPolicy', transportSource + '\nreturn callOffscreenHelper;')(async function() { return true; }, { runtime: { sendMessage: async function(m) { wire = m; return { ok: true, result: 1 }; } } }, { randomUUID: function() { return String(++sequence); } }, h.P);
    check('trusted transport completes test invocation', await transport('helper-js-eval', { _testRunContext: key, testRunPolicy: { workspace: 'forged' } }, 5000) === 1);
    check('wire descriptor comes only from host context', !wire.payload._testRunContext && wire.payload.testRunPolicy.workspace === 'owner/repo::main');
    check('completed transport id cannot retain capability', !h.P.registry.relay(wire.payload.sandboxRequestId, 'run_js_file', { path: 'a', mode: 'source' }).ok);
    await rejects('unknown context cannot start transport', function() { return transport('helper-js-eval', { _testRunContext: {} }, 5000); });

    // Fully execute the extracted SW relay with fake dispatcher, not source-only assertions.
    var relaySource = cut(sources['src/platform/extension/background.js'], "    if (message.type === 'sw-exec-tool') {", '\n    // Offscreen helper requests an UNTHROTTLED sleep');
    var chrome = { runtime: { id: 'test', getURL: function(p) { return 'chrome-extension://test/' + p; } } };
    var sw = realm(), relay = new Function('message', 'sender', 'sendResponse', 'executeTool', 'TestRunPolicy', 'chrome', startupSource + relaySource);
    key = sw.key(); sw.P.registry.bind('trusted-test', key); sw.P.registry.bind('trusted-general', null);
    function send(id, name, args, sender) { return new Promise(function(resolve) { relay({ type: 'sw-exec-tool', payload: { sandboxRequestId: id, name: name, args: args } }, sender || { id: 'test', url: chrome.runtime.getURL('offscreen.html') }, resolve, sw.dispatch, sw.P, chrome); }); }
    check('SW raw write denied before dispatcher', !(await send('trusted-test', 'workspace', { action: 'write', path: 'test/.scratch/a' })).ok && sw.calls.length === 0);
    check('SW raw cookie denied', !(await send('trusted-test', 'get_cookie', {})).ok);
    check('SW foreign workspace denied', !(await send('trusted-test', 'run_js_file', { path: 'a', mode: 'source', workspace: 'other' })).ok);
    check('SW unknown id denied', !(await send('forged', 'workspace', { action: 'write' })).ok);
    check('SW untrusted sender denied', !(await send('trusted-general', 'workspace', { action: 'write' }, { id: 'evil', url: 'evil' })).ok);
    check('SW safe source forwarded pinned', (await send('trusted-test', 'run_js_file', { path: 'a', mode: 'source' })).ok && sw.calls[0].args.workspace === 'owner/repo::main');
    check('SW general js_eval compatibility', (await send('trusted-general', 'workspace', { action: 'write' })).ok && sw.calls.length === 2);
    sw.P.registry.unbind('trusted-test'); check('SW revoked test denied', !(await send('trusted-test', 'run_js_file', { path: 'a', mode: 'source' })).ok);

    // Execute full offscreen ingress using its real handler + shared frame runner.
    h = realm(); var receiver, relayed = [];
    var offChrome = { runtime: { id: 'test', getURL: chrome.runtime.getURL,
        connect: function() { return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} } }; },
        onMessage: { addListener: function(fn) { receiver = fn; } },
        sendMessage: function(m) { relayed.push(m); return Promise.resolve({ ok: true, result: { success: true, content: 'safe' } }); }
    } };
    new Function('chrome', 'window', 'document', 'TestRunPolicy', 'AbortController', 'setTimeout', 'clearTimeout', 'Date', sources['src/platform/extension/offscreen-helper.js'])(offChrome, h.window, h.document, h.P, AbortController, h.setTimer, h.clearTimer, h.clock);
    var response;
    receiver({ type: 'helper-js-eval', payload: { sandboxRequestId: 'off-test', testRunPolicy: { workspace: 'owner/repo::main', deadline: 11000 }, code: '' } }, { id: 'test', url: chrome.runtime.getURL('background.js') }, function(r) { response = r; });
    frame = h.frames[0];
    h.emit(frame, { type: 'sandboxToolCall', id: 1, name: 'workspace', args: { action: 'push' } }); await flush();
    check('offscreen raw mutation blocked before SW relay', relayed.length === 0);
    h.emit(frame, { type: 'sandboxToolCall', id: 2, name: 'run_js_file', args: { path: 'a', mode: 'source' } }); await flush();
    check('offscreen safe read carries trusted host id', relayed.length === 1 && relayed[0].payload.sandboxRequestId === 'off-test');
    receiver({ type: 'helper-cancel-sandbox', payload: { sandboxRequestId: 'off-test' } }, { id: 'test' }, function() {}); await flush();
    check('offscreen cancel destroys exact test frame', h.removed() === 1 && response && response.ok === false);

    P = realm().P;
    var validStatus = function() { return Promise.resolve({ success: true, dirty_files: [{ path: 'src/a' }] }); };
    var validRead = function() { return Promise.resolve({ success: true, content: 'complete' }); };
    var hash = async function(s) { return s; };
    for (var bad of [{ success: false }, { success: true }, { success: true, dirty_files: [], capped: true }, { success: true, dirty_files: [], truncated: true }]) await rejects('snapshot rejects invalid status ' + JSON.stringify(bad), function() { return P.snapshot(function() { return Promise.resolve(bad); }, validRead, hash, 5); });
    await rejects('snapshot cap fails before reading', function() { return P.snapshot(validStatus, function() { throw new Error('must not read'); }, hash, 0); });
    await rejects('snapshot failed read fails closed', function() { return P.snapshot(validStatus, function() { return Promise.resolve({ success: false }); }, hash, 5); });
    await rejects('snapshot capped read fails closed', function() { return P.snapshot(validStatus, function() { return Promise.resolve({ success: true, content: 'partial', capped: true }); }, hash, 5); });
    var before = await P.snapshot(validStatus, validRead, hash, 5), after = await P.snapshot(validStatus, async function() { return { success: true, content: 'changed' }; }, hash, 5);
    check('complete snapshot fingerprints dirty source and detects changes', !P.compare(before, after).ok && before.fingerprints['src/a'] === 'complete');
    check('unchanged complete snapshots pass', P.compare(before, before).ok);

    // Dispatcher-level defensive check, independently from the policy.
    var discard; // Extract the explicit wsDiscard arm, not the surrounding router.
    var execSource = sources['src/js/tools/020-tool-execution.js'];
    var at = execSource.indexOf("        } else if (action === 'discard') {");
    var next = execSource.indexOf("        } else if", at + 10);
    discard = execSource.slice(at, next).replace(/^        } else if/, 'if') + '\n}\nreturn result;';
    var called = 0, AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    var discardHandler = new AsyncFunction('action', 'args', 'wk', 'chatId', 'chatTitle', 'force', 'wsDiscard', 'var result;\n' + discard);
    var fakeDiscard = async function() { called++; return { success: true }; };
    for (var selector of [{ files: ['test/.scratch/a'] }, { dest: 'test/.scratch/a' }]) check('malformed discard cannot reach discard-all ' + JSON.stringify(selector), (await discardHandler('discard', selector, 'wk', null, null, false, fakeDiscard)).success === false && called === 0);
    await discardHandler('discard', {}, 'wk', null, null, false, fakeDiscard); check('intentional top-level discard-all remains compatible', called === 1);

    check('page ingress uses shared host frame handler', sources['src/js/tools/020-tool-execution.js'].indexOf('await TestRunPolicy.runFrame({') >= 0);
    check('offscreen loads policy before helper', sources['src/platform/extension/offscreen.html'].indexOf('test-run-policy.js') < sources['src/platform/extension/offscreen.html'].indexOf('<script src="offscreen-helper.js"'));
    for (var builder of ['build/build.js', 'skills/extension-dev/build.js']) {
        check(builder + ' includes shared worker policy', sources[builder].indexOf("'js/core/075-test-run-policy.js'") >= 0 || sources[builder].indexOf("'src/js/core/075-test-run-policy.js'") >= 0);
        check(builder + ' emits exact offscreen policy artifact', sources[builder].indexOf('test-run-policy.js') >= 0);
    }
    check('deploy-managed manifest includes policy', /DEPLOY_ROOT_MANAGED[^\n]*'test-run-policy.js'/.test(sources['src/js/tools/020-tool-execution.js']));
    return passed;
}

// Harness registration; verification may call the runner directly with fake bridges.
var PATHS = ['src/js/core/075-test-run-policy.js', 'src/js/tools/020-tool-execution.js', 'src/platform/extension/background.js', 'src/platform/extension/offscreen-helper.js', 'src/platform/extension/offscreen.html', 'build/build.js', 'skills/extension-dev/build.js'];
await registerRunner('test-run-policy', async function() { return runTestRunPolicyTests(await loadSources(PATHS)); });
