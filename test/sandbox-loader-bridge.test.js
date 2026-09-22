// Execute the actual workspace sandbox script, not a copy of its loaders/bridge.
// All postMessage peers, source replies and timers are in-memory fixtures. This
// tests sandbox behavior, NOT Chrome transport or the host authorization boundary.
var sandboxHtml = await loadFile('src/platform/extension/sandbox.html');
var sandboxScripts = Array.from(sandboxHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
if (sandboxScripts.length !== 1) throw new Error('Expected one inline sandbox script; update fixture for a changed entry point');
var sandboxScript = sandboxScripts[0][1];

function loaderBridgeFixture(sources, autoReply) {
    var messages = [], listeners = [];
    var w = fakeWindow({
        setTimeout: function() { throw new Error('Unexpected fixture timer'); },
        clearTimeout: function() {},
        addEventListener: function(type, listener) { if (type === 'message') listeners.push(listener); }
    });
    var peer = { postMessage: function(message) {
        messages.push(message);
        if (autoReply !== false && message.type === 'sandboxToolCall') {
            queueMicrotask(function() {
                var found = Object.prototype.hasOwnProperty.call(sources || {}, message.args.path);
                emit({ type: 'sandboxToolResult', id: message.id, result: found
                    ? { success: true, content: sources[message.args.path] }
                    : { success: false, error: 'source missing: ' + message.args.path } });
            });
        }
    } };
    w.parent = peer;
    function emit(data, source) {
        listeners.forEach(function(listener) { listener({ source: source === undefined ? peer : source, data: data }); });
    }
    new Function('window', sandboxScript)(w);
    // Only the production loader's explicit safe intrinsic list is supplied.
    // No real tools, DOM, Chrome APIs or network are passed to loaded modules.
    w.SANDBOX_PASSTHROUGH_GLOBALS.forEach(function(name) {
        if (!(name in w)) w[name] = globalThis[name];
    });
    return {
        window: w, emit: emit, messages: messages,
        calls: function() { return messages.filter(function(m) { return m.type === 'sandboxToolCall'; }); }
    };
}

describe('workspace sandbox loaders and promise bridge', function() {
    test('loadFile requests raw source with explicit workspace, preserving Unicode', async function() {
        var text = 'const label = "\u201cquoted\u201d \u2014 caf\u00e9";\n';
        var h = loaderBridgeFixture({ 'src/raw.js': text });
        assert.strictEqual(h.messages[0].type, 'sandboxReady');
        assert.strictEqual(await h.window.loadFile('src/raw.js', 'owner/repo::branch'), text);
        assert.strictEqual(h.calls()[0].name, 'run_js_file');
        assert.deepStrictEqual(h.calls()[0].args, { path: 'src/raw.js', mode: 'source', workspace: 'owner/repo::branch' });
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), []);
    }, { tags: ['unit'], timeout: 2000 });

    test('runFile keeps returned and CommonJS functions callable; return wins', async function() {
        var h = loaderBridgeFixture({
            'return.js': 'module.exports = { wrong: true }; return function(n) { return args.base + n; };',
            'exports.js': 'exports.add = function(n) { return args.base + n; }; exports.filename = __filename;',
            'replace.js': 'module.exports = function(n) { return args.base * n; };'
        });
        var returned = await h.window.runFile('return.js', { base: 10 });
        var exported = await h.window.runFile('exports.js', { base: 20 });
        var replaced = await h.window.runFile('replace.js', { base: 3 });
        assert.strictEqual(returned(2), 12);
        assert.strictEqual(exported.add(2), 22);
        assert.strictEqual(exported.filename, 'exports.js');
        assert.strictEqual(replaced(4), 12);
        assert.deepStrictEqual(h.calls().map(function(c) { return c.args.mode; }), ['source', 'source', 'source']);
    }, { tags: ['unit'], timeout: 2000 });

    test('namespace fallback exposes real declarations and each run gets fresh state', async function() {
        var h = loaderBridgeFixture({ 'namespace.js': 'var count = 0;\nfunction next() { return ++count; }\nclass Box {}\nconst value = 7;' });
        var first = await h.window.runFile('namespace.js');
        var second = await h.window.runFile('namespace.js');
        assert.strictEqual(first.next(), 1);
        assert.strictEqual(first.next(), 2);
        assert.strictEqual(second.next(), 1);
        assert.strictEqual(first.value, 7);
        assert.ok(new first.Box() instanceof first.Box);
        assert.notStrictEqual(first.next, second.next);
    }, { tags: ['unit'], timeout: 2000 });

    test('ordered modules share dependencies but independent loads do not share scope', async function() {
        var h = loaderBridgeFixture({
            'dependency.js': 'var base = 4;\nfunction compute(n) { return base + n; }',
            'consumer.js': 'const answer = compute(3);\nfunction increase() { base++; return compute(3); }'
        });
        var first = await h.window.loadModules(['dependency.js', 'consumer.js'], { workspace: 'owner/repo::main' });
        assert.strictEqual(first.answer, 7);
        assert.strictEqual(first.increase(), 8);
        assert.deepStrictEqual(first.__unstubbed, []);
        var second = await h.window.loadModules(['dependency.js', 'consumer.js']);
        assert.strictEqual(second.answer, 7);
        assert.strictEqual(first.increase(), 9);
        assert.deepStrictEqual(h.calls().slice(0, 2).map(function(c) { return [c.args.path, c.args.workspace]; }),
            [['dependency.js', 'owner/repo::main'], ['consumer.js', 'owner/repo::main']]);
        await assert.rejects(h.window.loadModules(['consumer.js']), /global compute not stubbed/);
    }, { tags: ['unit'], timeout: 2000 });

    test('unknown globals fail; explicit stubs work and typeof probes are recorded', async function() {
        var h = loaderBridgeFixture({
            'strict.js': 'const value = document.title;',
            'probe.js': 'const available = typeof optionalApi !== "undefined";'
        });
        await assert.rejects(h.window.loadModules(['strict.js']), /global document not stubbed/);
        var stubbed = await h.window.loadModules(['strict.js'], { globals: { document: { title: 'fixture' } } });
        assert.strictEqual(stubbed.value, 'fixture');
        assert.deepStrictEqual(stubbed.__unstubbed, []);
        var probed = await h.window.loadModules(['probe.js']);
        assert.strictEqual(probed.available, false);
        assert.deepStrictEqual(probed.__unstubbed, ['optionalApi']);
    }, { tags: ['unit'], timeout: 2000 });

    test('failed source reads reject loaders and stop later reads', async function() {
        var h = loaderBridgeFixture({});
        await assert.rejects(h.window.loadFile('missing.js'), /loadFile\(missing.js\): source missing/);
        await assert.rejects(h.window.runFile('missing.js'), /source missing: missing.js/);
        await assert.rejects(h.window.loadModules(['missing.js', 'never-read.js']), /source missing: missing.js/);
        assert.deepStrictEqual(h.calls().map(function(c) { return c.args.path; }), ['missing.js', 'missing.js', 'missing.js']);
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), []);
    }, { tags: ['unit'], timeout: 2000 });

    test('concurrent replies correlate by id; foreign, unknown and duplicate replies are ignored', async function() {
        var h = loaderBridgeFixture({}, false), settled = [];
        var first = h.window.executeTool('first', { n: 1 }).then(function(v) { settled.push('first'); return v; });
        var second = h.window.executeTool('second', { n: 2 }).then(function(v) { settled.push('second'); return v; });
        var a = h.calls()[0], b = h.calls()[1];
        assert.notStrictEqual(a.id, b.id);
        h.emit({ type: 'sandboxToolResult', id: a.id, result: 'forged' }, {});
        h.emit({ type: 'sandboxToolResult', id: 999999, result: 'unknown' });
        await Promise.resolve();
        assert.deepStrictEqual(settled, []);
        assert.strictEqual(Object.keys(h.window._pendingCalls).length, 2);
        h.emit({ type: 'sandboxToolResult', id: b.id, result: 'B' });
        assert.strictEqual(await second, 'B');
        h.emit({ type: 'sandboxToolResult', id: b.id, result: 'duplicate' });
        await Promise.resolve();
        assert.deepStrictEqual(settled, ['second']);
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), [String(a.id)]);
        h.emit({ type: 'sandboxToolResult', id: a.id, result: 'A' });
        assert.strictEqual(await first, 'A');
        assert.deepStrictEqual(settled, ['second', 'first']);
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), []);
    }, { tags: ['unit'], timeout: 2000 });

    test('transport errors reject only their pending source read and release the entry', async function() {
        var h = loaderBridgeFixture({}, false);
        var failed = h.window.loadFile('broken.js');
        var rejection = assert.rejects(failed, /transport disconnected/);
        var good = h.window.executeTool('healthy', {});
        var a = h.calls()[0], b = h.calls()[1];
        h.emit({ type: 'sandboxToolResult', id: a.id, error: 'transport disconnected' });
        await rejection;
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), [String(b.id)]);
        h.emit({ type: 'sandboxToolResult', id: a.id, result: 'late recovery ignored' });
        h.emit({ type: 'sandboxToolResult', id: b.id, result: { ok: true } });
        assert.deepStrictEqual(await good, { ok: true });
        assert.deepStrictEqual(Object.keys(h.window._pendingCalls), []);
    }, { tags: ['unit'], timeout: 2000 });
});
