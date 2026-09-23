// extension_build (skills/extension-dev/build.js) delegates to the WORKSPACE
// copy of build.js, so build-logic edits (e.g. the __CHANGELOG__ Help-page
// substitution) apply on the FIRST Reload instead of only after the installed,
// embedded copy has been replaced by a previous Reload.
async function skillBuild() { return runFile('skills/extension-dev/build.js'); }

describe('extension_build self-load from the workspace', function() {
    test('delegates to the workspace extension_build with the resolved workspace and a recursion guard', async function() {
        var m = await skillBuild(), seenArgs = null, seenWs = null;
        var src = 'async function extension_build(a) { return { success: true, got: a }; }';
        var res = await m._runWorkspaceBuildJs({ branch: 'b' }, 'o/AppAgent::main', async function(a, w) { seenArgs = a; seenWs = w; return src; });
        assert.strictEqual(seenWs, 'o/AppAgent::main');
        assert.strictEqual(seenArgs.branch, 'b');
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.build_js, 'workspace');
        assert.strictEqual(res.got._fromWorkspaceBuildJs, true);
        assert.strictEqual(res.got.workspace, 'o/AppAgent::main');
        assert.strictEqual(res.got.branch, 'b');
    });

    test('never recurses: an already-delegated call does not read or delegate again', async function() {
        var m = await skillBuild(), reads = 0;
        var res = await m._runWorkspaceBuildJs({ _fromWorkspaceBuildJs: true }, 'w', async function() { reads++; return 'async function extension_build(a) { return 1; }'; });
        assert.strictEqual(res, null);
        assert.strictEqual(reads, 0);
    });

    test('falls back to the installed copy (null) on unreadable / invalid / function-less sources', async function() {
        var m = await skillBuild();
        assert.strictEqual(await m._runWorkspaceBuildJs({}, 'w', async function() { return null; }), null);
        assert.strictEqual(await m._runWorkspaceBuildJs({}, 'w', async function() { throw new Error('no read'); }), null);
        assert.strictEqual(await m._runWorkspaceBuildJs({}, 'w', async function() { return 'async function extension_build(a) { return {'; }), null);
        assert.strictEqual(await m._runWorkspaceBuildJs({}, 'w', async function() { return 'function somethingElse() {}'; }), null);
    });

    test('runtime errors of the workspace build are surfaced, not masked by a fallback rebuild', async function() {
        var m = await skillBuild(), threw = false;
        try { await m._runWorkspaceBuildJs({}, 'w', async function() { return 'async function extension_build(a) { throw new Error(\'boom\'); }'; }); }
        catch (e) { threw = /boom/.test(e.message); }
        assert.ok(threw);
    });

    test('line-number prefixes of workspace read output are stripped exactly', async function() {
        var m = await skillBuild();
        assert.strictEqual(m._stripReadLineNumbers('1\tvar a = 1;\n2\t    if (x)\t{}\n3\t'), 'var a = 1;\n    if (x)\t{}\n');
    });

    test('the real checked-in build.js compiles through the delegation wrapper and wires the delegation in', async function() {
        var src = await loadFile('skills/extension-dev/build.js');
        var AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        new AsyncFunction('args', src + '\n;return await extension_build(args);');
        assert.ok(/^async function extension_build\s*\(/m.test(src));
        var body = src.slice(src.search(/^async function extension_build\s*\(/m));
        var call = body.indexOf('await _runWorkspaceBuildJs(args, defaultWorkspace)');
        assert.ok(call > 0, 'extension_build delegates to the workspace copy');
        assert.ok(call < body.indexOf('ws("hydrate"'), 'delegation happens before any build work');
    });
});
