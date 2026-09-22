// Real-module unit tests: loadModules() evaluates the REAL src/js/** file in an
// isolated with-scope and we call the real functions. Proof set of increasing
// difficulty (pure helper → core module needing a stub → tools file).
// Convention: describe/test/assert are harness globals; tags default ['unit'].

describe('loadModules — real extension modules', function() {
    test('055-emoji-shortcodes: replaceEmojiShortcodes (pure helper, no stubs)', async function() {
        var m = await loadModules(['src/js/core/055-emoji-shortcodes.js']);
        assert.deepStrictEqual(m.__unstubbed, []);
        assert.strictEqual(typeof m.replaceEmojiShortcodes, 'function');
        assert.strictEqual(m.replaceEmojiShortcodes('done :white_check_mark: and :unknown_code:'), 'done \u2705 and :unknown_code:');
        assert.strictEqual(m.SECTION_ICON_SHORTCODES.rocket, '\uD83D\uDE80');
    });

    test('100-cached-results: detectCodeContentType / looksLikeCode / generateSmartOutline (stub: cacheTokenLimit)', async function() {
        var m = await loadModules(['src/js/core/100-cached-results.js'], { globals: { cacheTokenLimit: 4000 } });
        assert.strictEqual(m.getCacheCharLimit(), 16000, 'getCacheCharLimit reads the stubbed cacheTokenLimit global');
        assert.strictEqual(m.detectCodeContentType('<!DOCTYPE html><html>', ''), 'html');
        assert.strictEqual(m.detectCodeContentType('anything', 'client_script'), 'javascript');
        assert.strictEqual(m.detectCodeContentType('.btn { color: red }\n#id { margin: 0 }', ''), 'css');
        assert.strictEqual(m.looksLikeCode('function foo() {\n  var x = 1;\n  if (x) { return x; }\n}\n'), true);
        assert.strictEqual(m.looksLikeCode('short'), false);
        var o = m.generateSmartOutline({ a: [1, 2, 3], b: { c: 'd' } }, 2);
        assert.strictEqual(o.stats.totalKeys, 3);
        assert.strictEqual(o.stats.totalArrayItems, 3);
        assert.match(o.outline.a, /3 items/);
    });

    test('tools/160-run-tests: validators use the real policy dependency', async function() {
        var m = await loadModules(['src/js/core/075-test-run-policy.js', 'src/js/tools/160-run-tests.js']);
        assert.deepStrictEqual(m.__unstubbed, []);
        assert.strictEqual(m.rtValidateArgs({ tags: ['bogus'] }).ok, false);
        assert.match(m.rtValidateArgs({ tags: ['bogus'] }).error, /unknown tags: bogus/);
        assert.deepStrictEqual(m.rtValidateArgs({}).value.tags, ['unit', 'contract', 'canary']);
        assert.deepStrictEqual(m.rtSelectTestFiles(['a.test.js', 'harness.js', 'b.test.js'], 'a'), ['test/a.test.js']);
        assert.strictEqual(m.rjfValidateArgs({ path: 'x.js', mode: 'nope' }).ok, false);
        assert.strictEqual(m.RunTestsHelpers.rtValidateArgs, m.rtValidateArgs);
        var grant = { name: 'workspace', actions: ['status', 'diff'] };
        var valid = m.rtValidateArgs({ files: ['test/real-modules.test.js'], allow_tools: [grant] });
        assert.strictEqual(valid.ok, true);
        assert.deepStrictEqual(valid.value.allow_tools, [grant]);
        grant.actions.push('write');
        assert.deepStrictEqual(valid.value.allow_tools[0].actions, ['status', 'diff'], 'grants are copied, not retained by reference');
        assert.ok(Object.isFrozen(valid.value.allow_tools[0].actions));
        [
            { allow_tools: ['workspace'] },
            { allow_tools: [{ name: 'workspace', actions: ['write'] }] },
            { allow_tools: [{ name: 'workspace', actions: ['status'], force: true }] },
            { files: ['test/../escape.test.js'] }
        ].forEach(function(args) { assert.strictEqual(m.rtValidateArgs(args).ok, false); });
        assert.deepStrictEqual(m.__unstubbed, [], 'validation must not silently lose dependencies');
    });

    test('unstubbed global access throws; typeof guards are lenient', async function() {
        await assert.rejects(evalModules(['var y = document.title;'], ['neg']), /global document not stubbed/);
        var m = await evalModules(['var z = typeof Platform !== "undefined";\nclass K { m() { return 7; } }\nlet q = 5;\nconst c = 6;\nasync function af() { return 1; }\nfunction href() { return window.location.href; }\n'], ['lenient'],
            { globals: { window: fakeWindow() } });
        assert.strictEqual(m.z, false);
        assert.deepStrictEqual(m.__unstubbed, ['Platform']);
        assert.strictEqual(new m.K().m(), 7);
        assert.strictEqual(m.q, 5);
        assert.strictEqual(m.c, 6);
        assert.strictEqual(await m.af(), 1);
        assert.match(m.href(), /^chrome-extension:\/\/fake-extension-id\//);
    });

    test('passthrough web-API functions are bound to the real window (atob/btoa/structuredClone); constructors keep their statics', async function() {
        // loadModules(paths) = loadFile + evalModules; the with-Proxy scope is identical, so evalModules is the unit under test.
        var src = 'var decoded = atob("aGk=");\nvar encoded = btoa("hi");\nvar cloned = structuredClone({ a: [1] });\n' +
            'var keys = Object.keys({ x: 1 });\nvar resolved = await Promise.resolve(3);\nvar isArr = Array.isArray([]);\n' +
            'var encLen = new TextEncoder().encode("ab").length;\nvar stable = setTimeout === setTimeout;\nvar host = new URL("https://x.y/z").host;\nvar pi = parseInt("7");\nvar id = setTimeout(function() {}, 5); clearTimeout(id);\nvar fromUser = userFn();';
        var realWindow = window;
        var userFn = function() { return this; }; // with-scope call: `this` is the scope Proxy (spec), NOT rebound to window
        var m = await evalModules([src], ['bind'], { globals: { userFn: userFn } });
        assert.strictEqual(m.decoded, 'hi', 'atob must not throw Illegal invocation');
        assert.strictEqual(m.encoded, 'aGk=');
        assert.deepStrictEqual(m.cloned, { a: [1] });
        assert.deepStrictEqual(m.keys, ['x'], 'Object (constructor) must NOT be bound — statics stay reachable');
        assert.strictEqual(m.resolved, 3); assert.strictEqual(m.isArr, true); assert.strictEqual(m.encLen, 2); assert.strictEqual(m.host, 'x.y'); assert.strictEqual(m.pi, 7);
        assert.strictEqual(m.stable, true, 'bound passthrough functions are cached (stable identity)');
        assert.ok(m.fromUser !== realWindow && m.fromUser != null, 'user-provided globals are returned as-is, never bound to the real window');
        assert.deepStrictEqual(m.__unstubbed, []);
    });

    test('typeof rewrite + column-0 decl scan are string/comment/template aware (_maskJsSource)', async function() {
        // Before: the typeof rewrite fired inside "typeof foo is x" → SyntaxError; block-comment `var hidden` was exported.
        var src = 'var s = "typeof foo is x";\nvar s2 = \'typeof bar\';\nvar tpl = `text typeof baz ${typeof Tpl}`;\n/* typeof cmt\nvar hidden = 1;\nfunction hiddenFn() {}\n*/\n// typeof line\nvar rx = /["\'\\/]typeof x/g.source.length;\nvar real = typeof Platform !== "undefined";\nvar shown = 2;';
        var m = await evalModules([src], ['mask']);
        assert.strictEqual(m.s, 'typeof foo is x', 'double-quoted string untouched');
        assert.strictEqual(m.s2, 'typeof bar', 'single-quoted string untouched');
        assert.strictEqual(m.tpl, 'text typeof baz undefined', 'template text untouched, ${typeof Tpl} expression still lenient');
        assert.strictEqual(m.real, false, 'real typeof guard still rewritten (lenient)');
        assert.deepStrictEqual(m.__unstubbed, ['Tpl', 'Platform'], 'only the two real typeof reads are recorded');
        assert.strictEqual(typeof m.rx, 'number', 'regex literal body is masked, not treated as string/comment start');
        var keys = Object.keys(m);
        assert.ok(keys.indexOf('hidden') < 0 && keys.indexOf('hiddenFn') < 0, 'block-comment declarations are not exported: ' + keys.join(','));
        assert.deepStrictEqual(keys, ['s', 's2', 'tpl', 'rx', 'real', 'shown']);
        assert.deepStrictEqual(_topLevelDeclNames('/*\nvar hidden = 1;\n*/\nvar shown = 2;\nvar t = `\nconst inTpl = 3;\n`;'), ['shown', 't']);
        var masked = _maskJsSource('a = "x\\"y"; // c\nb = /\\/[/]/i; c = `q${d}r`;');
        assert.strictEqual(masked.length, 'a = "x\\"y"; // c\nb = /\\/[/]/i; c = `q${d}r`;'.length, 'mask preserves length');
        assert.strictEqual(masked, 'a = "    ";     \nb = /     /i; c = ` ${d} `;');
        assert.strictEqual(_maskJsSource('var s = "unterminated'), 'var s = "unterminated', 'unterminated literal → raw source fallback');
        // evalModule (CommonJS path) uses the same decl scan for its namespace fallback
        var ns = await evalModule('/*\nvar nope = 1;\n*/\nvar yes = 1;', 'x.js', {});
        assert.deepStrictEqual(Object.keys(ns), ['yes']);
    });

    test('fakeChrome: storage.local round-trip + call log', async function() {
        var ch = fakeChrome();
        await ch.storage.local.set({ a: 1 });
        assert.deepStrictEqual(await ch.storage.local.get('a'), { a: 1 });
        assert.deepStrictEqual(await ch.storage.local.get({ a: 0, b: 2 }), { a: 1, b: 2 });
        assert.strictEqual(ch.runtime.getURL('/panel.html'), 'chrome-extension://fake-extension-id/panel.html');
        assert.strictEqual(ch._calls[0].api, 'storage.local.set');
    });
});
