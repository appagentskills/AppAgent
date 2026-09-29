// build/i18n-extract.js: string extractor + catalog checker (pure, sandbox-safe).
var IX_PATH = 'build/i18n-extract.js';
var IX = null;
async function ix() { if (!IX) IX = await runFile(IX_PATH, { i18n: false }); return IX; }
function srcs(r) { return r.map(function(e) { return e.source; }); }
function byKey(r, k) { return r.filter(function(e) { return e.source === k; })[0]; }
var SC = '<' + '/script>';

describe('i18n extractor: t / tn / N_ calls', function() {
    test('literals (escapes decoded), sorted unique sources, refs, plural pairs', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({
            'src/js/a.js': [
                "var x = t('Save');",
                'var y = t("Say \\"hi\\"", { n: 1 });',
                "var z = t('Don\\'t stop');",
                "var p = tn(items.length, '{count} file', '{count} files');",
                "var l = { a: N_('Label A'), b: N_(\"Label B\") };",
                "t('Save'); t( 'Save' ) ;",
                "var w = tn(fn(a, [b, c]), 'One row', \"{count} rows\", { x: 1 });"
            ].join('\n'),
            'src/js/b.js': "t('Save')\n"
        });
        assert.deepStrictEqual(srcs(r), ["Don't stop", 'Label A', 'Label B', 'Save', 'Say "hi"', '{count} files', '{count} rows']);
        assert.deepStrictEqual(byKey(r, 'Save').refs, ['src/js/a.js:1', 'src/js/a.js:6', 'src/js/b.js:1']);
        assert.deepStrictEqual(byKey(r, '{count} files').plural, { one: '{count} file', other: '{count} files' });
        assert.deepStrictEqual(byKey(r, '{count} rows'), { source: '{count} rows', refs: ['src/js/a.js:7'], plural: { one: 'One row', other: '{count} rows' } });
        assert.strictEqual('plural' in byKey(r, 'Save'), false);
        assert.deepStrictEqual(r.nonLiteral, []);
        assert.strictEqual(Object.prototype.propertyIsEnumerable.call(r, 'nonLiteral'), false, 'nonLiteral is non-enumerable');
    });
    test('non-literal keys are reported in nonLiteral, not extracted', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'src/js/c.js': ["t(`Hello`);", "t(label);", "t('Hi ' + name);", "tn(n, one, 'x');", "tn(n, 'a');", "t(`A ${b}`);", "N_(x);", "t();"].join('\n') });
        assert.deepStrictEqual(srcs(r), ['Hello'], 'a substitution-free template is a literal key (G2)');
        assert.deepStrictEqual(r.nonLiteral, ['src/js/c.js:2', 'src/js/c.js:3', 'src/js/c.js:4', 'src/js/c.js:5', 'src/js/c.js:6', 'src/js/c.js:7', 'src/js/c.js:8']);
    });
    test('ignores member calls, look-alike identifiers, declarations, comments, strings, regexes', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'src/js/d.js': [
            "foo.t('A'); obj?.t('B'); this.tn(1, 'C', 'D'); x.N_('E');",
            "split('F'); set('G'); at('H'); _t('I'); $t('J'); it('K'); tt('L'); Nt('M');",
            "function t(source, params) { return source; }",
            "function tn(n, one, other) { return other; }",
            "// t('comment')",
            "/* t('block') */",
            "var s = \"t('in string')\";",
            "var re = /t\\('re'\\)/g, re2 = /[/']/;",
            "var q = a / t('Divided') / 2;",
            "var m = { t(x) { return x; } };"
        ].join('\n') });
        assert.deepStrictEqual(srcs(r), ['Divided']);
        assert.deepStrictEqual(byKey(r, 'Divided').refs, ['src/js/d.js:9']);
        assert.deepStrictEqual(r.nonLiteral, []);
    });
    test('template substitutions (nested) are scanned; lines survive CRLF + multi-line tokens', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({
            'src/js/e.js': "el.innerHTML = `<b>${t('Title')}</b><i>${items.map(i => `<u>${t('Item {n}', { n: i })}</u>`).join('')}</i>`;\nvar h = `\n  ${t('Line three')}`;",
            'src/js/f.js': "/* a\n b */\r\nvar s = `x\ny`;\r\nt('After CRLF');"
        });
        assert.deepStrictEqual(srcs(r), ['After CRLF', 'Item {n}', 'Line three', 'Title']);
        assert.deepStrictEqual(byKey(r, 'Line three').refs, ['src/js/e.js:3']);
        assert.deepStrictEqual(byKey(r, 'After CRLF').refs, ['src/js/f.js:5']);
    });
});

describe('i18n extractor: data-i18n markup', function() {
    test('HTML files: own text nodes, entities, whitespace, data-i18n-attr, comments, RCDATA', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'src/html/x.html': [
            '<div class="a">',
            '  <button data-i18n title="Close  panel" data-i18n-attr="title, aria-label" aria-label="Close">',
            '    <i class="icon"></i>  Save &amp;   close',
            '  </button>',
            '  <p data-i18n>Hello <b>world</b> again &hellip;</p>',
            '  <p>Not <span>marked</span></p>',
            '  <input data-i18n-attr="placeholder" placeholder="Search&nbsp;tables">',
            '  <span data-i18n>   </span><br>',
            '  <!-- <span data-i18n>Commented</span> -->',
            '  <label data-i18n>Multi',
            '    line   label</label>',
            '  <title data-i18n>App &lt;Agent&gt;</title>',
            '</div>'
        ].join('\n') });
        assert.deepStrictEqual(srcs(r), ['App <Agent>', 'Close', 'Close panel', 'Hello', 'Multi line label', 'Save & close', 'Search tables', 'again \u2026']);
        var lines = r.map(function(e) { return e.refs.join(','); });
        assert.deepStrictEqual(lines, ['src/html/x.html:12', 'src/html/x.html:2', 'src/html/x.html:2', 'src/html/x.html:5', 'src/html/x.html:10', 'src/html/x.html:3', 'src/html/x.html:7', 'src/html/x.html:5']);
        assert.deepStrictEqual(r.nonLiteral, []);
    });
    test('HTML files: inline JS <script> bodies and on* handlers; non-JS scripts skipped', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'src/html/y.html': ['<script>', "  document.title = t('Window title');", SC,
            '<button onclick="showSnackbar(t(&quot;Copied&quot;))">x</button>',
            '<script type="application/json">{"k": "t(\'no\')"}' + SC, '<script src="a.js">' + SC].join('\n') });
        assert.deepStrictEqual(srcs(r), ['Copied', 'Window title']);
        assert.deepStrictEqual(byKey(r, 'Window title').refs, ['src/html/y.html:2']);
        assert.deepStrictEqual(byKey(r, 'Copied').refs, ['src/html/y.html:4']);
    });
    test('JS strings: literal, joined + chains, templates; dynamic parts go to nonLiteral', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'src/js/g.js': [
            "a.innerHTML = '<button data-i18n><i class=\"x\"></i> Refresh</button>';",
            "b.innerHTML = '<span data-i18n>' +",
            "    'Two lines</span>';",
            "c.innerHTML = '<span data-i18n>' + esc(name) + '</span>';",
            "d.innerHTML = `<a data-i18n-attr=\"title\" title=\"Open ${x}\">${t('Open')}</a>`;",
            "e.innerHTML = `<p data-i18n>Static text</p>`;",
            "html += '<div data-i18n>';",
            "f.innerHTML = '<em data-i18n title=\"T\" data-i18n-attr=\"title\">Hi ' + who + '</em>';",
            "var sel = '[data-i18n], [data-i18n-attr]';"
        ].join('\n') });
        assert.deepStrictEqual(srcs(r), ['Open', 'Refresh', 'Static text', 'T', 'Two lines']);
        assert.deepStrictEqual(byKey(r, 'Two lines').refs, ['src/js/g.js:3']);
        assert.deepStrictEqual(r.nonLiteral, ['src/js/g.js:4', 'src/js/g.js:5', 'src/js/g.js:7', 'src/js/g.js:8']);
    });
    test('robust on odd input: never throws, unterminated tokens/markup', async function() {
        var X = await ix();
        assert.deepStrictEqual(X.extractI18nStrings(null), []);
        assert.deepStrictEqual(X.extractI18nStrings({ 'a.js': 42, 'b.css': "t('x')", 'c.json': '{"t(\'y\')": 1}' }), []);
        var r = X.extractI18nStrings({ 'a.js': "t('unterminated\nvar r = /[/;\n`open ${t('In tpl')}", 'b.html': '<p data-i18n>Tail text', 'c.html': '<p data-i18n title="x' });
        assert.deepStrictEqual(srcs(r), ['In tpl', 'Tail text']);
        assert.deepStrictEqual(r.nonLiteral, ['a.js:1']);
        assert.strictEqual(X.normalizeI18nKey('  a \n\t b\u00a0 '), 'a b');
        assert.strictEqual(X.decodeHtmlEntities('&lt;&#65;&#x42;&bogus;&amp;'), '<AB&bogus;&');
    });
});

describe('i18n extractor: #1032 edge cases (G1 optional call, G2 plain template)', function() {
    test('G1: t?.(), tn?.() and N_?.() are calls; the key is extracted', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'o.js': "var a = t?.('Opt');\nvar b = tn?.(n, 'One opt', '{count} opts');\nN_?.('Opt label');\nt?.(v);" });
        assert.deepStrictEqual(srcs(r), ['Opt', 'Opt label', '{count} opts']);
        assert.deepStrictEqual(byKey(r, '{count} opts').plural, { one: 'One opt', other: '{count} opts' });
        assert.deepStrictEqual(byKey(r, 'Opt').refs, ['o.js:1']);
        assert.deepStrictEqual(r.nonLiteral, ['o.js:4'], 't?.(variable) is reported, not dropped');
    }, { tags: ['unit'] });
    test('G1: ?. not followed by ( and obj?.t() stay ignored', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'o.js': "var a = t?.x('No'); obj?.t('No2'); obj?.t?.('No3'); var c = t ?.('Spaced');" });
        assert.deepStrictEqual(srcs(r), ['Spaced']);
        assert.deepStrictEqual(r.nonLiteral, []);
    }, { tags: ['unit'] });
    test('G2: `Hello` is a key (escapes cooked), `a${x}` stays nonLiteral, tn templates too', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'g.js': ["t(`Hello`);", "t(`a${x}`);", "t(`Tab\\tQ \\u0041`);", "tn(n, `One tpl`, `{count} tpls`);", "N_(`Tpl label`, 1);", "t(`Hello` + x);"].join('\n') });
        assert.deepStrictEqual(srcs(r), ['Hello', 'Tab\tQ A', 'Tpl label', '{count} tpls']);
        assert.deepStrictEqual(byKey(r, 'Hello').refs, ['g.js:1']);
        assert.deepStrictEqual(byKey(r, '{count} tpls').plural, { one: 'One tpl', other: '{count} tpls' });
        assert.deepStrictEqual(r.nonLiteral, ['g.js:2', 'g.js:6']);
    }, { tags: ['unit'] });
    test('window.t() / obj.t() / this.t() are member calls and are ignored (documented)', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'w.js': "window.t('x'); obj.t('x'); this.t('y'); window.tn(1, 'a', 'b'); globalThis.N_('z');" });
        assert.deepStrictEqual(srcs(r), []);
        assert.deepStrictEqual(r.nonLiteral, []);
        var doc = await loadFile(IX_PATH);
        assert.match(doc, /Member calls \(foo\.t\(\), window\.t\(\), obj\?\.t\(\)\)/, 'header documents the member-call rule');
    }, { tags: ['unit'] });
    test('mutant killer: a key call as the body of a braceless if before a block is extracted', async function() {
        var X = await ix();
        var r = X.extractI18nStrings({ 'a.js': "if (a) t('IfBody')\n{ b(); }" });
        assert.deepStrictEqual(srcs(r), ['IfBody']);
        var m = X.extractI18nStrings({ 'm.js': "var o = { t('NotKey') { return 1; } };" });
        assert.deepStrictEqual(srcs(m), [], 'a real method definition is still skipped');
    }, { tags: ['unit'] });
    test('checkCatalog: tn source with a non-object plural and non-string plural values', async function() {
        var X = await ix();
        var r = X.checkCatalog([{ source: '{count} a', plural: 'nope' }, { source: '{count} b {x}', plural: { one: 5, other: 7 } }],
            { '{count} a': '{count} A', '{count} b {x}': { one: 'un {x}', other: 7 } });
        assert.deepStrictEqual(r.missing, ['{count} b {x}'], 'a non-string other is missing');
        assert.deepStrictEqual(r.placeholderMismatch, []);
        var s = X.checkCatalog([{ source: '{count} a', plural: 'nope' }], { '{count} a': 'A' });
        assert.deepStrictEqual(s.placeholderMismatch, [{ source: '{count} a', category: null, missing: ['count'], unexpected: [] }], 'string plural = not plural: {count} required');
        var o = X.checkCatalog([{ source: '{count} b {x}', plural: { one: 5, other: 7 } }], { '{count} b {x}': { one: 'un', other: 'des {x}' } });
        assert.deepStrictEqual(o.placeholderMismatch, [{ source: '{count} b {x}', category: 'one', missing: ['x'], unexpected: [] }], 'non-string plural forms fall back to the key');
    }, { tags: ['unit'] });
});

describe('i18n checkCatalog', function() {
    test('missing / extra / placeholder mismatches (plural categories, optional {count})', async function() {
        var X = await ix();
        var src = X.extractI18nStrings({ 'a.js': "t('Hello {name}'); t('Save'); tn(n, '{count} file in {dir}', '{count} files in {dir}'); t('Only {count}'); t('Gone'); tn(n, 'A file', 'Files');" });
        var r = X.checkCatalog(src, {
            'Hello {name}': 'Bonjour {nom}', 'Save': 'Enregistrer', 'Only {count}': 'Seulement', 'Gone': '', 'Old key': 'Ancienne',
            '{count} files in {dir}': { one: '{count} fichier dans {dir}', few: 'Fichiers {dir}', other: '{count} fichiers dans {dir} {x}' },
            'Files': { one: '{count} fichier', other: '{count} fichiers' }
        });
        assert.deepStrictEqual(r.missing, ['Gone']);
        assert.deepStrictEqual(r.extra, ['Old key']);
        assert.deepStrictEqual(r.placeholderMismatch, [
            { source: 'Hello {name}', category: null, missing: ['name'], unexpected: ['nom'] },
            { source: 'Only {count}', category: null, missing: ['count'], unexpected: [] },
            { source: '{count} files in {dir}', category: 'other', missing: [], unexpected: ['x'] }
        ]);
    });
    test('string-array sources, object values, null catalog', async function() {
        var X = await ix();
        var r = X.checkCatalog(['A {x}', 'B', 'A {x}'], { 'A {x}': { other: 'Des {x}', one: 'Un' }, 'B': { one: 'b' } });
        assert.deepStrictEqual(r, { missing: ['B'], extra: [], placeholderMismatch: [{ source: 'A {x}', category: 'one', missing: ['x'], unexpected: [] }] });
        assert.deepStrictEqual(X.checkCatalog(['B', 'A'], null), { missing: ['A', 'B'], extra: [], placeholderMismatch: [] });
        assert.deepStrictEqual(X.checkCatalog(null, { a: 'b' }).extra, ['a']);
    });
});

describe('i18n extractor: sandbox safety', function() {
    test('evaluates in a strict empty scope (no host globals); module.exports is guarded', async function() {
        var m = await loadModules([IX_PATH], { workspace: args.workspace, globals: {}, i18n: false });
        var r = m.extractI18nStrings({ 'a.js': "t('X')", 'b.html': '<b data-i18n>Y</b>' });
        assert.deepStrictEqual(srcs(r), ['X', 'Y']);
        assert.deepStrictEqual(m.checkCatalog(r, { X: 'x' }).missing, ['Y']);
        assert.deepStrictEqual((m.__unstubbed || []).filter(function(n) { return n !== 'module'; }), []);
        var X = await ix();
        assert.deepStrictEqual(Object.keys(X).sort(), ['checkCatalog', 'decodeHtmlEntities', 'extractI18nStrings', 'normalizeI18nKey']);
        var own = await loadFile(IX_PATH);
        assert.ok(!/\brequire\s*\(/.test(own), 'no require()');
        var self = X.extractI18nStrings({ 'build/i18n-extract.js': own });
        assert.deepStrictEqual([self.length, self.nonLiteral.length], [0, 0], 'self-scan: lexer survives its own regexes/strings');
    });
});
