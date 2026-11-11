// Unit tests for the shared tokenizer-backed extractor (test/extract.js).
var EX = await runFile('test/extract.js', { i18n: false });

function run(code, ret) { return new Function(code + '\nreturn ' + ret + ';')(); }

describe('test/extract.js — code mask + function extraction', function() {
    test('regex containing a double quote does not open a string', function() {
        var src = 'function esc(s) {\n    return s.replace(/["\\\\]/g, "_");\n}\nfunction after() { return 1; }\n';
        var code = EX.extractFunction(src, 'esc');
        assert.strictEqual(code, 'function esc(s) {\n    return s.replace(/["\\\\]/g, "_");\n}');
        assert.strictEqual(run(code, 'esc')('a"b\\c'), 'a_b_c');
    }, { tags: ['unit'] });

    test('regex containing a backtick and a brace does not open a template', function() {
        var src = 'function tick(s) { var re = /[`{]/g; return s.replace(re, "-"); }\nvar x = `}`;\n';
        var code = EX.extractFunction(src, 'tick');
        assert.strictEqual(code, 'function tick(s) { var re = /[`{]/g; return s.replace(re, "-"); }');
        assert.strictEqual(run(code, 'tick')('a`b{c'), 'a-b-c');
    }, { tags: ['unit'] });

    test('template literal with braces and nested ${} (including a nested template)', function() {
        var src = 'function tpl(a) {\n    return `{ ${a ? `x{${ {k: a}.k }}` : "}"} }`;\n}\nfunction next() {}\n';
        var code = EX.extractFunction(src, 'tpl');
        assert.strictEqual(code.slice(-2), '\n}');
        assert.strictEqual(run(code, 'tpl')(5), '{ x{5} }');
        assert.strictEqual(run(code, 'tpl')(0), '{ } }');
    }, { tags: ['unit'] });

    test('comments containing braces and quotes are ignored', function() {
        var src = 'function c() {\n    // a } and a " and a \' in a line comment\n    /* { ` } " */\n    return 7;\n}\n';
        var code = EX.extractFunction(src, 'c');
        assert.strictEqual(run(code, 'c')(), 7);
        assert.strictEqual(code.length, src.length - 1);
    }, { tags: ['unit'] });

    test('division is not mistaken for a regex (and regex after keywords / if (...) is)', function() {
        var src = 'function d(a, b) {\n    var q = a / b / 2, r = (a) / 1, s = [a][0] / 1;\n    a++ / 1;\n' +
            '    if (a) /}/.test("x");\n    var t = typeof /{/;\n    return q + r + s + (t === "object" ? 0 : 99);\n}\nfunction e() {}\n';
        var code = EX.extractFunction(src, 'd');
        assert.strictEqual(code.slice(-2), '\n}');
        assert.strictEqual(run(code, 'd')(8, 2), 2 + 8 + 8);
    }, { tags: ['unit'] });

    test('nested functions: the outer cut ends at its own brace; inner names are found too', function() {
        var src = 'function outer() {\n    function inner() { return { a: "}" }; }\n    return inner().a;\n}\nfunction other() {}\n';
        assert.strictEqual(run(EX.extractFunction(src, 'outer'), 'outer')(), '}');
        assert.strictEqual(EX.extractFunction(src, 'inner'), 'function inner() { return { a: "}" }; }');
        assert.strictEqual(EX.findFunction(src, 'inner', { topLevel: true }), null);
    }, { tags: ['unit'] });

    test('mentions in strings / comments are skipped; async prefix and param defaults handled', function() {
        var src = '// function f() { old }\nvar s = "function f() {";\nasync function f(a = {}, { b } = {}) {\n    return a;\n}\n';
        var f = EX.findFunction(src, 'f');
        assert.ok(f && f.isAsync);
        assert.strictEqual(src.slice(f.start, f.end), 'async function f(a = {}, { b } = {}) {\n    return a;\n}');
        assert.strictEqual(EX.extractFunction(src, 'f', { includeAsync: false }).indexOf('function f('), 0);
        assert.strictEqual(EX.extractFrom(src, 'async function f('), src.slice(f.start, f.end));
    }, { tags: ['unit'] });

    test('mask keeps length and line breaks; missing names throw', function() {
        var src = 'var a = "x\\"y";\nvar b = `l1\nl2`;\n';
        var mask = EX.codeMask(src);
        assert.strictEqual(mask.length, src.length);
        assert.strictEqual(mask.split('\n').length, src.split('\n').length);
        assert.throws(function() { EX.extractFunction(src, 'nope'); }, /not found/);
        assert.deepStrictEqual(EX.extractFunctions('function a(){}\nfunction b(){}', ['b', 'a']), 'function b(){}\nfunction a(){}');
    }, { tags: ['unit'] });

    test('real source: _findWidgetPlaceholder is cut exactly and compiles', async function() {
        var src = await loadFile('src/js/ui/250-message-render.js');
        var code = EX.extractFunction(src, '_findWidgetPlaceholder');
        new Function(code);
        assert.strictEqual(code.indexOf('function _findWidgetPlaceholder('), 0);
        assert.strictEqual(code.slice(-1), '}');
        assert.ok(code.length < 4000, 'cut stays inside the function: ' + code.length);
    }, { tags: ['unit'], timeout: 5000 });
});
