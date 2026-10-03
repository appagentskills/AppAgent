// Exercise the real CLI scanner without running the build or writing dist/.
var swScannerSource = await loadFile('build/build.js');
var swScannerStart = swScannerSource.indexOf('const SW_SCANNER_BUILTINS =');
var swScannerEnd = swScannerSource.indexOf('// ─── Decl-parity check:', swScannerStart);
if (swScannerStart < 0 || swScannerEnd < 0) throw new Error('SW scanner region not found');
var swScanner = new Function(swScannerSource.slice(swScannerStart, swScannerEnd) +
    '\nreturn { scan: scanSwBundleGaps, mask: _swScannerStripCommentsAndStrings };')();
function swGapNames(src) { return swScanner.scan(src).gaps.map(function(g) { return g.name; }); }

describe('SW bundle scanner regex masking', function() {
    test('HTTP capture group is data, not a free call', function() {
        var src = String.raw`var hm = /HTTP (\d{3})/.exec(s), code = hm ? +hm[1] : 0;`;
        assert.deepStrictEqual(swGapNames(src), []);
        assert.strictEqual(swScanner.mask(src).includes('HTTP'), false);
    }, {tags: ['unit']});

    test('actual smart-document fixture no longer reports HTTP', async function() {
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        var fixture = src.split('\n').find(function(line) { return line.includes('var hm = /HTTP'); });
        assert.ok(fixture, 'expected real HTTP regex fixture');
        assert.deepStrictEqual(swGapNames(fixture), []);
    }, {tags: ['unit']});

    test('escaped delimiters, character classes and flags remain regex data', function() {
        [String.raw`var r = /HTTP(\/x)[/]/gi; afterRegex();`,
         String.raw`var r = /[\]\/"']HTTP(foo)/g; afterRegex();`,
         'var r = /[`"\'\\n]HTTP(foo)/g; afterRegex();',
         'var r = /https?:\\/\\/HTTP(foo)/; afterRegex();'].forEach(function(src) {
            assert.deepStrictEqual(swGapNames(src), ['afterRegex']);
        });
    }, {tags: ['unit']});

    test('expression positions and control statement bodies accept regex literals', function() {
        ['var r = /HTTP(foo)/;', 'return /HTTP(foo)/;', 'throw /HTTP(foo)/;',
         'var r = true ? /HTTP(foo)/ : /Other(bar)/;',
         'var r = [/HTTP(foo)/];', 'var r = {r: /HTTP(foo)/};',
         'if (ok) /HTTP(foo)/.test(s);', 'while (ok) /HTTP(foo)/.test(s);',
         'if ((ok)) /* comment */ /HTTP(foo)/.test(s);',
         'var r = () => /HTTP(foo)/;'].forEach(function(src) {
            assert.deepStrictEqual(swGapNames(src), []);
        });
    }, {tags: ['unit']});

    test('real HTTP and other missing calls are still fatal gaps', function() {
        assert.deepStrictEqual(swGapNames('var r = /HTTP(foo)/; HTTP(); missingDependency();'), ['HTTP', 'missingDependency']);
    }, {tags: ['unit']});

    test('division operands cannot be swallowed as regex text', function() {
        ['value / missing() / divisor;', '42 / missing() / 2;',
         '(value) / missing() / divisor;', 'obj.value / missing() / divisor;',
         'obj.return / missing() / divisor;', 'obj.if(value) / missing() / divisor;',
         'value++ / missing() / divisor;', 'value-- / missing() / divisor;',
         'arr[0] / missing() / divisor;', '({}) / missing() / divisor;',
         '"value" / missing() / divisor;', 'value /= missing();',
         'var r = /HTTP(foo)/ / missing() / divisor;'].forEach(function(src) {
            assert.deepStrictEqual(swGapNames(src), ['missing']);
        });
    }, {tags: ['unit']});

    test('contextual words used as identifiers cannot hide division calls', function() {
        ['of', 'await', 'yield'].forEach(function(name) {
            var src = 'var ' + name + ' = 4; ' + name + ' / missing() / 2;';
            // These are legal identifiers in this sloppy-script context.
            assert.strictEqual(typeof new Function(src), 'function');
            assert.deepStrictEqual(swGapNames(src), ['missing']);
            assert.strictEqual(swScanner.mask(src), src);
        });
        assert.deepStrictEqual(swGapNames('function f(await, yield, of) { return await / missing() / of; }'), ['missing']);
    }, {tags: ['unit']});

    test('actual contextual operators support unambiguous parenthesized regex operands', function() {
        ['async function f() { await (/HTTP(foo)/); missing(); }',
         'var f = function* () { yield (/HTTP(foo)/); missing(); };',
         'for (var item of (/HTTP(foo)/)) { missing(); }'].forEach(function(src) {
            assert.strictEqual(typeof new Function(src), 'function');
            assert.deepStrictEqual(swGapNames(src), ['missing']);
        });
    }, {tags: ['unit']});

    test('ambiguous bare regex after contextual operators stays conservatively visible', function() {
        ['async function f() { await /HTTP(foo)/; missing(); }',
         'var f = function* () { yield /HTTP(foo)/; missing(); };',
         'for (var item of /HTTP(foo)/) { missing(); }'].forEach(function(src) {
            assert.strictEqual(typeof new Function(src), 'function');
            assert.deepStrictEqual(swGapNames(src), ['HTTP', 'missing']);
        });
    }, {tags: ['unit']});

    test('division right operand can itself be a regex', function() {
        assert.deepStrictEqual(swGapNames('var x = value / /HTTP(foo)/.test(s); missing();'), ['missing']);
    }, {tags: ['unit']});

    test('template interpolation calls stay visible', function() {
        assert.deepStrictEqual(swGapNames('var s = `hello ${missing()} ${/HTTP(foo)/.test(s)}`; after();'), ['after', 'missing']);
    }, {tags: ['unit']});

    test('comments and strings cannot invent free calls', function() {
        assert.deepStrictEqual(swGapNames('/* fake() */ var s = "HTTP(foo)"; // other()\nactual();'), ['actual']);
        assert.deepStrictEqual(swGapNames('prefix/* comment */actual();'), ['actual']);
    }, {tags: ['unit']});

    test('declared and typeof-guarded call classification is unchanged', function() {
        var result = swScanner.scan('function declared() {} declared(); if (typeof optional === "function") optional(); missing();');
        assert.deepStrictEqual(result.gaps.map(function(g) { return g.name; }), ['missing']);
        assert.deepStrictEqual(result.guardedGaps.map(function(g) { return g.name; }), ['optional']);
    }, {tags: ['unit']});

    test('uncertain unterminated regex does not swallow subsequent code', function() {
        assert.deepStrictEqual(swGapNames('var r = /broken\nmissing();'), ['missing']);
        assert.deepStrictEqual(swGapNames('var r = /broken'), []);
    }, {tags: ['unit']});

    test('operator and string masking distinguish mutation-sensitive contexts', function() {
        assert.strictEqual(swScanner.mask('value ** /HTTP(foo)/;'), 'value **  ;');
        assert.strictEqual(swScanner.mask('value + /HTTP(foo)/;'), 'value +  ;');
        assert.strictEqual(swScanner.mask('value(/HTTP(foo)/);'), 'value( );');
        assert.strictEqual(swScanner.mask('\'HTTP(foo)\' "HTTP(foo)"'), '   ');
        assert.strictEqual(swScanner.mask("'x\\'HTTP(foo)' after();"), '  after();');
        assert.strictEqual(swScanner.mask("'broken\nnext();"), ' \nnext();');
    }, {tags: ['unit']});

    test('empty source and numeric/prefix expression contexts are stable', function() {
        assert.deepStrictEqual(swGapNames(''), []);
        assert.deepStrictEqual(swGapNames(' \n '), []);
        assert.deepStrictEqual(swGapNames('var x = !/HTTP(foo)/.test(s); var y = ++value / missing() / 2;'), ['missing']);
    }, {tags: ['unit']});
});
