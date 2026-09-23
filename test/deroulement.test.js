// Unit tests for the REAL skills/feature-deroulement/deroulement.js (executable déroulement helper).
// Every check gets a passing fixture and an intentionally broken one, run offline via opts.corpus
// (deterministic). A few tests use the live, read-only workspace grep/ls/read to validate the
// patterns the helper sends (\b, lookbehind for $ names, ignore_case:false, cssDir 'src/css').
// The file has a top-level `return` (run_js_file module mode), so it is loaded with runFile, not loadModules.
var DR_PATH = 'skills/feature-deroulement/deroulement.js';
describe('deroulement.js (feature-deroulement executable checks)', function() {
    var D = null;
    async function load() { if (!D) D = await runFile(DR_PATH, {}); return D; }
    // Names built at runtime so the literal never appears in this file (live greps would find it).
    function ghost(stem) { return stem + 'Zq' + 'x' + 'Ghost'; }

    test('module shape: API functions and limitations are exported', async function() {
        var d = await load();
        ['run', 'mask', 'parseGateJs', 'parseGateHtml', 'proseSymbols', 'checkSymbols', 'crossRefs', 'cssClasses',
            'parseDiff', 'findFunctions', 'changedFunctions', 'fnSource', 'listeners', 'branches', 'matrix', 'instrument',
            'probe', 'edgeValues', 'edgeInputs', 'domPostconditions', 'mutants', 'mutationTest', 'ledger', 'format'
        ].forEach(function(k) { assert.strictEqual(typeof d[k], 'function', k); });
        assert.ok(Array.isArray(d.limitations) && d.limitations.length >= 10);
    }, { tags: ['unit'] });

    // (a) parse gate
    test('parseGateJs: valid source passes; broken source fails with an unbalanced-bracket hint', async function() {
        var d = await load();
        assert.strictEqual(d.parseGateJs('ok.js', 'function a(x) { return [x, {y: 1}]; }\nexport default a;').ok, true);
        var bad = d.parseGateJs('bad.js', 'function a(x) {\n  if (x) {\n    return 1;\n}\n');
        assert.strictEqual(bad.ok, false);
        assert.match(bad.error, /SyntaxError/);
        assert.match(bad.hint, /unclosed "\{" opened at line 1/);
    }, { tags: ['unit'] });

    test('parseGateHtml: clean markup passes; dup id, missing handler and handler syntax error are flagged', async function() {
        var d = await load(), known = function(n) { return n === 'save'; };
        var ok = d.parseGateHtml('ok.html', '<div id="a"><button onclick="save()">Save</button></div>', known);
        assert.strictEqual(ok.ok, true);
        assert.deepStrictEqual(ok.ids, ['a']);
        var bad = d.parseGateHtml('bad.html', '<div id="a"></div><p id="a"></p><button onclick="gone()">x</button><button onclick="if(">y</button>', known);
        assert.strictEqual(bad.ok, false);
        var kinds = bad.issues.map(function(i) { return i.kind + ':' + i.subject; });
        assert.ok(kinds.indexOf('duplicate-id:a') >= 0, kinds.join());
        assert.ok(kinds.indexOf('missing-handler:gone') >= 0, kinds.join());
        assert.ok(kinds.some(function(k) { return /^handler-syntax/.test(k); }), kinds.join());
    }, { tags: ['unit'] });

    // (b) prose symbols
    test('proseSymbols + checkSymbols (corpus): real symbols verified, invented ones refuted', async function() {
        var d = await load();
        var corpus = { 'src/a.js': 'function alpha(x) {\n  return x + 1;\n}\nalpha(2);\n', 'src/a.css': '.btn-x { color: red; }\n' };
        var ps = d.proseSymbols('Click → `alpha()` in `src/a.js:1`, styled by `.btn-x`. Also `a + b` and `if`.');
        assert.deepStrictEqual(ps.symbols.map(function(s) { return s.kind + ':' + s.name; }), ['function:alpha', 'fileRef:src/a.js', 'cssClass:btn-x']);
        assert.ok(ps.skipped.indexOf('a + b') >= 0 && ps.skipped.indexOf('if') >= 0);
        var good = await d.checkSymbols(ps.symbols, { corpus: corpus });
        assert.deepStrictEqual(good.map(function(r) { return r.status; }), ['verified', 'verified', 'verified']);
        assert.match(good[0].evidence, /defined at src\/a\.js:1/);
        var bad = await d.checkSymbols(d.proseSymbols('`betaMissing()`, `src/a.js:99`, `.nope-class`, `alpha:40`, `src/none.js`').symbols, { corpus: corpus });
        assert.deepStrictEqual(bad.map(function(r) { return r.name + '=' + r.status; }),
            ['betaMissing=refuted', 'src/a.js=refuted', 'nope-class=refuted', 'alpha=unverified', 'src/none.js=refuted']);
        assert.match(bad[1].evidence, /line out of range: file has 5 lines/);
        assert.match(bad[3].evidence, /not near a definition/);
    }, { tags: ['unit'] });

    test('checkSymbols: no grep => unverified (never "0 hits"); capped grep without a definition => unverified, uncapped => refuted', async function() {
        var d = await load(), sym = [{ kind: 'function', name: 'foo', raw: 'foo()' }];
        var noGrep = { live: false, read: async function() { return null; }, grep: async function() { return null; }, diff: async function() { return null; }, ls: async function() { return []; } };
        var r1 = await d.checkSymbols(sym, { io: noGrep });
        assert.strictEqual(r1[0].status, 'unverified');
        assert.strictEqual(r1[0].evidence, 'grep unavailable');
        function ioWith(truncated) {
            return Object.assign({}, noGrep, { grep: async function() { var a = [{ file: 'x.js', line: 3, text: 'foo(1);' }]; a.truncated = truncated; return a; } });
        }
        assert.strictEqual((await d.checkSymbols(sym, { io: ioWith(true) }))[0].status, 'unverified');
        assert.strictEqual((await d.checkSymbols(sym, { io: ioWith(false) }))[0].status, 'refuted');
    }, { tags: ['unit'] });

    // cross-refs
    test('crossRefs: wired ids/classes/messages pass; ghost id, unstyled class, unhandled and sender-less types are flagged', async function() {
        var d = await load(), cssFiles = ['src/css/a.css'];
        var corpus = { 'src/css/a.css': '.btn-x { color: red }', 'src/html/body.html': '<div id="panel"></div>' };
        var ok = await d.crossRefs({ 'src/js/ui.js': "var p = document.getElementById('panel');\np.classList.add('btn-x');\nchrome.runtime.sendMessage({ type: 'ping' });\nfunction onMsg(msg) { switch (msg.type) { case 'ping': return 1; } }\n" }, { corpus: corpus, cssFiles: cssFiles });
        assert.deepStrictEqual([ok.ids.missing.length, ok.classes.noCss.length, ok.messages.unhandled.length, ok.messages.noSender.length], [0, 0, 0, 0]);
        assert.deepStrictEqual(cssFiles, ['src/css/a.css'], 'caller cssFiles array must not be mutated');
        var bad = await d.crossRefs({ 'src/js/ui.js': "var p = document.getElementById('ghost');\np.classList.add('no-style');\nchrome.runtime.sendMessage({ type: 'orphan' });\nfunction onMsg(msg) { switch (msg.type) { case 'lonely': return 1; } }\n" }, { corpus: corpus });
        assert.strictEqual(bad.classes.cssFiles, 1, 'default cssDir src/css is listed from the corpus');
        assert.deepStrictEqual(bad.ids.missing.map(function(x) { return x.name + (x.unverifiable ? '?' : ''); }), ['ghost']);
        assert.deepStrictEqual(bad.classes.noCss.map(function(x) { return x.name; }), ['no-style']);
        assert.deepStrictEqual(bad.messages.unhandled.map(function(x) { return x.name; }), ['orphan']);
        assert.deepStrictEqual(bad.messages.noSender.map(function(x) { return x.name; }), ['lonely']);
    }, { tags: ['unit'] });

    // (c) diff -> changed functions -> listeners
    test('parseDiff + changedFunctions map hunks to the innermost named function; listeners flag render-path re-binding', async function() {
        var d = await load();
        var src = 'function outer() {\n  var a = 1;\n}\nfunction renderList(el) {\n  el.addEventListener(\'click\', onClick);\n  return el;\n}\nfunction onClick() {}\n';
        var map = d.parseDiff('--- a/src/x.js\n+++ b/src/x.js\n@@ -4,3 +4,3 @@\n function renderList(el) {\n-  el.onclick = onClick;\n+  el.addEventListener(\'click\', onClick);\n   return el;\n');
        assert.deepStrictEqual(map['src/x.js'], [5]);
        assert.deepStrictEqual(d.changedFunctions(src, map['src/x.js']).map(function(f) { return f.name; }), ['renderList']);
        assert.deepStrictEqual(d.changedFunctions(src, [99]), [], 'a line outside every function maps to nothing');
        var ls = d.listeners('src/x.js', src, d.findFunctions(src));
        assert.strictEqual(ls.length, 1);
        assert.strictEqual(ls[0].handler, 'onClick');
        assert.strictEqual(ls[0].renderPathRisk, true);
        var safe = src.replace("onClick);\n  return", "onClick, { once: true });\n  return");
        assert.strictEqual(d.listeners('src/x.js', safe, d.findFunctions(safe))[0].renderPathRisk, false);
    }, { tags: ['unit'] });

    // (d) branches
    test('branches: returns heading a same-line case/try/catch arm are not early returns; a real guard return still is', async function() {
        var d = await load();
        var route = "function route(k, x) {\n  if (!x) return null;\n  switch (k) { case 'a': return 1; case 'b': return 2; }\n  try { return JSON.parse(x); } catch (e) { return x; }\n  return 0;\n}\n";
        assert.deepStrictEqual(d.branches(route).map(function(r) { return r.kind + '@' + r.line; }),
            ['if@2', 'early-return@2', 'case@3', 'case@3', 'catch@4']);
        var guard = "function g(x) {\n  if (!x) {\n    return null;\n  }\n  return x * 2;\n}\n";
        assert.deepStrictEqual(d.branches(guard).map(function(r) { return r.kind; }), ['if', 'early-return']);
        assert.match(d.matrix(d.branches(guard), 'g'), /\| B1 \| 2 \| if \| `!x` \|/);
    }, { tags: ['unit'] });

    // (e) probe
    test('probe: full input set hits every arm; a partial set reports the missed arms; missing stubs are named', async function() {
        var d = await load();
        var sign = "function sign(n) {\n  if (n > 0) { return 'pos'; }\n  else if (n < 0) { return 'neg'; }\n  return 'zero';\n}";
        var full = await d.probe(sign, { inputs: [[1], [-1], [0]] });
        assert.strictEqual(full.ok, true);
        assert.strictEqual(full.coverage.arms, 4);
        assert.deepStrictEqual(full.coverage.missed, []);
        assert.deepStrictEqual(full.runs.map(function(r) { return r.result; }), ['"pos"', '"neg"', '"zero"']);
        var part = await d.probe(sign, { inputs: [[1]] });
        assert.ok(part.coverage.missed.length > 0 && part.coverage.missed.indexOf('B1:F') >= 0, part.coverage.missed.join());
        var f = 'function f(x){ if (helper(x)) return 1; return 2; }';
        assert.deepStrictEqual((await d.probe(f, { inputs: [[1]] })).missingStubs, ['helper']);
        var stubbed = await d.probe(f, { inputs: [[1]], stubs: { helper: function() { return true; } } });
        assert.deepStrictEqual(stubbed.missingStubs, []);
        assert.strictEqual(stubbed.runs[0].result, '1');
    }, { tags: ['unit'] });

    // (f) edge inputs + DOM post-conditions
    test('edgeInputs + domPostconditions: clean render passes; undefined text, unnamed button and live XSS payload fail', async function() {
        var d = await load();
        assert.strictEqual(d.edgeInputs(['a', 1]).length, 2 * d.edgeValues().length);
        assert.deepStrictEqual(d.edgeInputs(['a'], { only: ['null', 'xss'] }).map(function(i) { return i.label; }), ['arg0=null', 'arg0=xss']);
        assert.strictEqual(d.domPostconditions('<div><button>Save</button><span>3 items</span></div>').ok, true);
        var bad = d.domPostconditions('<div><button></button><span>undefined items</span><img src=x onerror="window.__drXss=1"></div>');
        assert.deepStrictEqual(bad.issues.map(function(i) { return i.kind; }), ['bad-text', 'no-accessible-name', 'xss']);
    }, { tags: ['unit'] });

    test('probe with edge inputs + mountDom: an escaping renderer passes, a naive one renders the XSS payload', async function() {
        var d = await load(), U = await runFile('test/ui-helpers.js', {});
        var safe = "function renderTag(label) { var s = String(label == null ? '' : label).replace(/[&<>\"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); return '<span class=\"tag\">' + (s || '-') + '</span>'; }";
        var naive = "function renderTag(label) { return '<span class=\"tag\">' + label + '</span>'; }";
        var only = { only: ['null', 'undefined', 'xss'] };
        var ps = await d.probe(safe, { inputs: d.edgeInputs(['x'], only) });
        assert.ok(ps.runs.every(function(r) { return r.post && r.post.ok; }), JSON.stringify(ps.runs.map(function(r) { return r.post; })));
        var pn = await d.probe(naive, { inputs: d.edgeInputs(['x'], only) });
        var kinds = pn.runs.map(function(r) { return r.label + ':' + r.post.issues.map(function(i) { return i.kind; }).join('+'); });
        // literal "null" text is not a bad-text marker (only undefined / NaN / [object Object] are)
        assert.deepStrictEqual(kinds, ['arg0=null:', 'arg0=undefined:bad-text', 'arg0=xss:xss+xss']);
        // same check on a real mounted DOM (test/ui-helpers.js)
        var m = await U.mountDom({ html: '<div><button class="icon-btn"></button></div>' });
        try { assert.deepStrictEqual(d.domPostconditions(m.root).issues.map(function(i) { return i.kind; }), ['no-accessible-name']); }
        finally { m.cleanup(); }
    }, { tags: ['unit'] });

    // (g) mutation-lite
    test('mutationTest: boundary cases kill every mutant; a weak check lets one survive; a wrong check fails baseline', async function() {
        var d = await load(), grade = "function grade(s){ if (s >= 50) return 'pass'; return 'fail'; }";
        var strong = await d.mutationTest(grade, null, { cases: [{ args: [49], expect: 'fail' }, { args: [50], expect: 'pass' }, { args: [51], expect: 'pass' }] });
        assert.deepStrictEqual([strong.baselineOk, strong.total, strong.killed, strong.survived.length, strong.score], [true, 2, 2, 0, 100]);
        var weak = await d.mutationTest(grade, null, { cases: [{ args: [90], expect: 'pass' }] });
        assert.deepStrictEqual(weak.survived.map(function(s) { return s.op; }), ['>= -> >']);
        var wrong = await d.mutationTest(grade, null, { cases: [{ args: [90], expect: 'fail' }] });
        assert.strictEqual(wrong.baselineOk, false);
        assert.ok(d.mutants("function f(a){ for (var i = 0; i < a; i++) {} return a > 1; }").every(function(m) { return m.op !== '< -> <='; }), 'loop headers are never mutated');
    }, { tags: ['unit'] });

    // (h) run() pipeline + ledger gate
    var FEAT = "function renderThing(items) {\n  if (!items) return '';\n  return items.map(function (i) { return '<li>' + i + '</li>'; }).join('');\n}\nfunction boot() { document.body.innerHTML = renderThing(['a']); }\nboot();\n";
    test('run(): a correct prose + wired corpus passes the gate', async function() {
        var d = await load();
        var rep = await d.run({ corpus: { 'src/js/feat.js': FEAT }, files: ['src/js/feat.js'],
            diff: "@@ -1,3 +1,3 @@\n function renderThing(items) {\n-  x\n+  if (!items) return '';\n",
            prose: 'On load `boot()` calls `renderThing()` (`src/js/feat.js:1`), which returns `<li>` markup.' });
        assert.strictEqual(rep.gate.pass, true, JSON.stringify(rep.gate.refuted));
        assert.strictEqual(rep.summary.refuted, 0);
        assert.strictEqual(rep.summary.liveLookups, false);
        assert.deepStrictEqual(rep.changedFunctions.map(function(f) { return f.name + ':' + f.refs; }), ['renderThing:1']);
        assert.deepStrictEqual(rep.symbols.map(function(s) { return s.status; }), ['verified', 'verified', 'verified']);
        assert.match(d.format(rep), /### Claims ledger: PASS/);
        assert.strictEqual(rep.limitations.length, d.limitations.length);
    }, { tags: ['unit'] });

    test('run(): parse error, invented symbol, bad line citation and unwired function fail the gate', async function() {
        var d = await load();
        var rep = await d.run({ corpus: { 'src/js/feat.js': FEAT, 'src/js/bad.js': 'function x( {', 'src/js/lone.js': 'function orphanFn() { return 1; }\n' },
            files: ['src/js/feat.js', 'src/js/bad.js', 'src/js/lone.js'],
            prose: 'Click → `renderGhost()` at `src/js/feat.js:500`.' });
        assert.strictEqual(rep.gate.pass, false);
        var ref = rep.gate.refuted.join('\n');
        assert.match(ref, /src\/js\/bad\.js parses/);
        assert.match(ref, /`renderGhost\(\)` exists/);
        assert.match(ref, /line out of range/);
        assert.match(ref, /orphanFn .* is referenced beyond its definition/);
        assert.ok(rep.changedFunctions.every(function(f) { return f.changedVia === 'whole-file (no diff available)'; }));
        var waived = await d.run({ corpus: { 'src/js/lone.js': 'function orphanFn() { return 1; }\n' }, files: ['src/js/lone.js'], entryPoints: ['orphanFn'] });
        assert.strictEqual(waived.gate.pass, true, 'declared entry points are downgraded to unverified');
        assert.strictEqual(waived.summary.unverified, 1);
    }, { tags: ['unit'] });

    test('run(): >5 branches requires reverse mode; the branch claim is verified only when a probe hits every arm', async function() {
        var d = await load();
        var R = "function pick(a, b, c) {\n  if (a) { x(); }\n  if (b) { x(); }\n  if (c) { x(); }\n  if (a && b) { x(); }\n  if (b || c) { x(); }\n  return 0;\n}\nfunction x() {}\npick(1, 2, 3);\n";
        var base = { corpus: { 'src/js/r.js': R }, files: ['src/js/r.js'] };
        var bare = await d.run(base);
        assert.deepStrictEqual(bare.summary.reverseModeRequired, ['pick']);
        var row = bare.ledger.rows.filter(function(r) { return r.kind === 'branch'; })[0];
        assert.strictEqual(row.status, 'unverified');
        assert.match(d.format(bare), /#### Branch matrix: pick/);
        var full = await d.run(Object.assign({ probes: [{ file: 'src/js/r.js', fn: 'pick', stubs: { x: function() {} }, inputs: [[1, 1, 1], [0, 0, 0]] }] }, base));
        assert.strictEqual(full.ledger.rows.filter(function(r) { return r.kind === 'branch'; })[0].status, 'verified');
        var part = await d.run(Object.assign({ probes: [{ file: 'src/js/r.js', fn: 'pick', stubs: { x: function() {} }, inputs: [[1, 1, 1]] }] }, base));
        assert.match(part.ledger.rows.filter(function(r) { return r.kind === 'branch'; })[0].evidence, /missed B1:F/);
    }, { tags: ['unit'] });

    test('module mode: runFile with args.run returns the JSON report; custom claims feed the ledger', async function() {
        var rep = await runFile(DR_PATH, { run: true, corpus: { 'src/js/feat.js': FEAT }, files: ['src/js/feat.js'],
            claims: [{ claim: '2 + 2 is 4', check: true }, { claim: 'wrong', check: false, evidence: 'asserted false' }, { claim: 'unknown' }] });
        assert.strictEqual(rep.version, (await load()).version);
        assert.strictEqual(rep.gate.pass, false);
        assert.deepStrictEqual(rep.claims.map(function(c) { return c.status; }), ['verified', 'refuted', 'unverified']);
    }, { tags: ['unit'] });

    // live, read-only lookups against the real workspace (validates the grep/ls patterns the helper sends)
    test('live lookups: \\b and $-lookbehind greps are accepted; cssDir src/css is read', async function() {
        var d = await load();
        var syms = [{ kind: 'function', name: 'drRun', raw: 'drRun()' }, { kind: 'function', name: ghost('dr'), raw: 'x()' }, { kind: 'identifier', name: '$' + ghost('dr'), raw: 'y' }];
        var r = await d.checkSymbols(syms, {});
        assert.strictEqual(r[0].status, 'verified', r[0].evidence);
        assert.match(r[0].evidence, /deroulement\.js/);
        assert.deepStrictEqual([r[1].status, r[1].evidence], ['refuted', '0 hits']);
        assert.deepStrictEqual([r[2].status, r[2].evidence], ['refuted', '0 hits'], 'lookbehind pattern must be accepted by workspace grep');
        var cr = await d.crossRefs({ 'src/js/x.js': "el.classList.add('" + ghost('dr-cls-') + "');" }, {});
        assert.ok(cr.classes.cssFiles >= 20, 'src/css listed live: ' + cr.classes.cssFiles);
        assert.ok(cr.classes.cssRules > 100);
        assert.strictEqual(cr.classes.noCss.length, 1);
    }, { tags: ['unit'], timeout: 30000 });

    // ---- review follow-ups (PR #961 review) ----
    test('Bug A: Promise .catch(fn) is not a catch clause; the probe builds and a real catch stays one row', async function() {
        var d = await load();
        var src = "function load(p) {\n  var r = p.then(function (x) { return x; }).catch(() => ({}));\n  try { if (p) r = 1; } catch (e) { r = 2; }\n  return r;\n}";
        var kinds = d.branches(src).map(function(b) { return b.kind; });
        assert.strictEqual(kinds.filter(function(k) { return k === 'catch'; }).length, 1, kinds.join());
        assert.match(d.instrument(src).src, /catch \(e\) \{__t\("B\d+",true\);/);
        var pr = await d.probe(src, { inputs: [[Promise.resolve(1)]] });
        assert.strictEqual(pr.ok, true, pr.error);
        assert.strictEqual(pr.runs[0].threw, null);
    }, { tags: ['unit'] });

    test('Bug C: a mutation baseline that throws ReferenceError reports missingStubs and is unverified, not refuted', async function() {
        var d = await load(), f = "function total(a){ if (a > 0) return helperA(a) + helperB(a); return 0; }";
        var mu = await d.mutationTest(f, null, { cases: [{ args: [2], expect: 4 }] });
        assert.strictEqual(mu.baselineOk, false);
        assert.deepStrictEqual(mu.missingStubs, ['helperA', 'helperB']);
        var rep = await d.run({ corpus: { 'src/js/t.js': f + '\ntotal(1);\n' }, files: ['src/js/t.js'], functions: ['total'],
            mutation: [{ file: 'src/js/t.js', fn: 'total', cases: [{ args: [2], expect: 4 }] }] });
        var row = rep.ledger.rows.filter(function(r) { return r.kind === 'mutation'; })[0];
        assert.strictEqual(row.status, 'unverified');
        assert.match(row.evidence, /missing stubs: helperA, helperB/);
        var ok = await d.mutationTest(f, null, { cases: [{ args: [2], expect: 4 }], stubs: { helperA: function(x) { return x; }, helperB: function(x) { return x; } } });
        assert.strictEqual(ok.baselineOk, true);
        var wrong = await d.mutationTest(f, null, { cases: [{ args: [2], expect: 5 }], stubs: { helperA: function(x) { return x; }, helperB: function(x) { return x; } } });
        assert.strictEqual(wrong.missingStubs, undefined, 'a genuinely wrong check is still a baseline failure');
    }, { tags: ['unit'] });

    test('exclude: test fixtures (default ^test/) get only the parse gate, never refuted cross-ref or wiring rows', async function() {
        var d = await load();
        var fx = "test('x', function () { var html = \"document.getElementById('ghost')\"; document.getElementById('ghostTwo'); });\nfunction fixtureOnly() {}\n";
        var c = { 'src/js/feat.js': FEAT, 'test/feat.test.js': fx }, files = ['src/js/feat.js', 'test/feat.test.js'];
        var diff = { 'src/js/feat.js': '@@ -1,1 +1,1 @@\n-x\n+function renderThing(items) {\n' };
        var rep = await d.run({ corpus: c, files: files, diff: diff });
        assert.deepStrictEqual(rep.excluded, ['test/feat.test.js']);
        assert.strictEqual(rep.gate.pass, true, rep.gate.refuted.join('\n'));
        assert.ok(rep.parse.some(function(p) { return p.file === 'test/feat.test.js' && p.ok; }), 'parse gate still runs on excluded files');
        var all = await d.run({ corpus: c, files: files, diff: diff, exclude: [] });
        assert.strictEqual(all.gate.pass, false, 'exclude:[] analyses the fixture');
        assert.match(all.gate.refuted.join('\n'), /#ghostTwo/);
    }, { tags: ['unit'] });

    test('whole-file analysis collapses reverse-mode rows into one summary row; opts.functions scopes it', async function() {
        var d = await load();
        function mk(n) { return 'function ' + n + '(a, b, c) {\n  if (a) {}\n  if (b) {}\n  if (c) {}\n  if (a && b) {}\n  if (b || c) {}\n  return 0;\n}\n' + n + '(1, 2, 3);\n'; }
        var c = { 'src/js/m.js': ['fa', 'fb', 'fc', 'fd'].map(mk).join('') };
        var rep = await d.run({ corpus: c, files: ['src/js/m.js'] });
        var br = rep.ledger.rows.filter(function(r) { return r.kind === 'branch'; });
        assert.strictEqual(br.length, 1);
        assert.match(br[0].claim, /^4 functions have more than 5 branch points/);
        assert.match(br[0].evidence, /fa \(7\), fb \(7\), fc \(7\), fd \(7\)\. Pass opts\.functions/);
        assert.match(d.format(rep), /4 whole-file branch matrices omitted/);
        var one = await d.run({ corpus: c, files: ['src/js/m.js'], functions: ['fb', 'nope'] });
        assert.deepStrictEqual(one.changedFunctions.map(function(f) { return f.name + ':' + f.changedVia; }), ['fb:opts.functions']);
        assert.deepStrictEqual(one.functionsNotFound, ['nope']);
        assert.match(d.format(one), /#### Branch matrix: fb/);
    }, { tags: ['unit'] });

    test('Bug B: parseDiff does not count the next file header as a deletion in a multi-file diff', async function() {
        var d = await load();
        var diff = ['diff --git a/src/a.js b/src/a.js', 'index 1..2 100644', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
            'diff --git a/src/b.js b/src/b.js', 'index 3..4 100644', '--- a/src/b.js', '+++ b/src/b.js', '@@ -10,1 +10,2 @@', ' ctx', '+added'].join('\n');
        var want = { 'src/a.js': [2], 'src/b.js': [11] };
        assert.deepStrictEqual(d.parseDiff(diff), want);
        var plain = diff.split('\n').filter(function(l) { return !/^(diff --git|index )/.test(l); }).join('\n');
        assert.deepStrictEqual(d.parseDiff(plain), want, 'a --- line directly followed by +++ is a header even inside a hunk');
    }, { tags: ['unit'] });

    test('checkSymbols: built-in names are verified-builtin (low confidence) or unverified; test-only definitions do not verify', async function() {
        var d = await load();
        var corpus = { 'src/js/p.js': 'var xs = [1].find(function (v) { return v; });\n', 'test/p.test.js': 'function fixtureHelper() {}\n' };
        var syms = d.proseSymbols('`find()` then `splice()` then `fixtureHelper()`').symbols;
        var r = await d.checkSymbols(syms, { corpus: corpus });
        assert.deepStrictEqual(r.map(function(s) { return s.status; }), ['verified-builtin', 'unverified', 'unverified']);
        assert.strictEqual(r[0].confidence, 'low');
        assert.match(r[1].evidence, /0 repo uses/);
        assert.match(r[2].evidence, /defined only in test\//);
        var rep = await d.run({ corpus: corpus, files: ['src/js/p.js'], prose: '`find()` runs.' });
        var row = rep.ledger.rows.filter(function(x) { return x.kind === 'symbol'; })[0];
        assert.deepStrictEqual([row.status, row.confidence], ['verified', 'low']);
        assert.strictEqual(rep.ledger.counts.lowConfidence, 1);
        assert.match(d.format(rep), /OK \(low confidence\)/);
    }, { tags: ['unit'] });

    test('crossRefs: a capped (truncated) grep is cached with its own flag and makes id/message lookups unverifiable', async function() {
        var d = await load();
        var io = { live: true, read: async function() { return null; }, ls: async function() { return []; }, diff: async function() { return null; },
            grep: async function(p) { var a = [{ file: 'src/js/z.js', line: 1, text: 'noise' }]; a.truncated = /capped/.test(p); return a; } };
        var files = { 'src/js/u.js': "document.getElementById('cappedId'); document.getElementById('plainId'); document.getElementById('cappedId');\nchrome.runtime.sendMessage({ type: 'cappedMsg' });\n" };
        var cr = await d.crossRefs(files, { io: io, cssDir: false });
        assert.deepStrictEqual(cr.ids.missing.map(function(u) { return u.name + ':' + !!u.unverifiable; }), ['cappedId:true', 'plainId:false', 'cappedId:true']);
        assert.deepStrictEqual(cr.messages.unhandled.map(function(u) { return u.name + ':' + !!u.unverifiable; }), ['cappedMsg:true']);
        var L = d.ledger({ crossRefs: cr });
        assert.match(L.rows.filter(function(r) { return /cappedMsg/.test(r.claim); })[0].evidence, /capped at 100/);
        assert.deepStrictEqual(L.rows.filter(function(r) { return r.status === 'refuted'; }).map(function(r) { return r.subject; }), ['plainId']);
    }, { tags: ['unit'] });

    // ---------- v1.3.0 regressions: false PASS / false FAIL / crash (one minimal repro per bug) ----------
    function mkIO(corpus, over) {
        return Object.assign({ live: false,
            read: async function(p) { return Object.prototype.hasOwnProperty.call(corpus, p) ? corpus[p] : null; },
            grep: async function(pat) { var re = new RegExp(pat), out = []; Object.keys(corpus).forEach(function(p) { String(corpus[p]).split('\n').forEach(function(x, i) { if (re.test(x)) out.push({ file: p, line: i + 1, text: x }); }); }); return out; },
            diff: async function() { return null; }, ls: async function() { return []; } }, over || {});
    }
    function boom() { throw new Error('boom'); }
    function rowOf(rep, re) { return rep.ledger.rows.filter(function(r) { return re.test(r.claim + ' | ' + r.evidence); }); }
    var M = 'function f(x) { if (x > 0) return 1; return 0; }\nf(1);\n', LONE = { 'src/js/lone.js': 'function orphanFn() { return 1; }\n' };
    var PICK = 'function pick(a) {\n  if (a === 1) return 1;\n  if (a === 2) return 2;\n  if (a === 3) return 3;\n  if (a === 4) return 4;\n  if (a === 5) return 5;\n  if (a === 6) return 6;\n  return 0;\n}\nfunction other() { return pick(1); }\nother();\n';
    // [id, opts, expected gate.pass, [rowRegex, expected status] | null, extra(rep)]
    var MATRIX = [
        ['bug1 missing file is a refuted row', { files: ['typo.js'], corpus: {} }, false, [/typo\.js is readable/, 'refuted']],
        ['bug1 read throws -> refuted file row + ioErrors', { io: mkIO({}, { read: boom }), files: ['a.js'], cssDir: false }, false, [/a\.js is readable.*read failed: boom/, 'refuted'], function(r) { assert.strictEqual(r.ioErrors.length, 1); }],
        ['bug1 read returns a non-string', { io: mkIO({}, { read: async function() { return {}; } }), files: ['a.js'], cssDir: false }, false, [/a\.js is readable/, 'refuted']],
        ['bug2 waive cannot hide a syntax error', { files: { 'bad.js': 'function a({' }, corpus: {}, waive: { 'bad.js': 'x' } }, false, [/bad\.js parses/, 'refuted']],
        ['bug2 entryPoint cannot hide a failing mutation baseline', { corpus: { 'm.js': M }, files: ['m.js'], mutation: [{ file: 'm.js', fn: 'f', cases: [{ args: [1], expect: 2 }] }], entryPoints: ['f'] }, false, [/f mutation check passes/, 'refuted']],
        ['bug2 waive cannot hide a failing mutation baseline', { corpus: { 'm.js': M }, files: ['m.js'], mutation: [{ file: 'm.js', fn: 'f', cases: [{ args: [1], expect: 2 }] }], waive: { f: 'x' } }, false, [/f mutation check passes/, 'refuted']],
        ['bug2 waive cannot hide a probe failure', { corpus: { 'm.js': M }, files: ['m.js'], probes: [{ file: 'm.js', fn: 'nopeFn' }], waive: { nopeFn: 'x' } }, false, [/nopeFn probe builds/, 'refuted']],
        ['bug2 waive cannot hide an invented symbol', { corpus: { 'a.js': 'var a = 1;\n' }, prose: '\x60ghostZqA()\x60', waive: { ghostZqA: 'x' } }, false, [/ghostZqA/, 'refuted']],
        ['bug2 entryPoint cannot hide an invented symbol', { corpus: { 'a.js': 'var a = 1;\n' }, prose: '\x60ghostZqB()\x60', entryPoints: ['ghostZqB'] }, false, [/ghostZqB/, 'refuted']],
        ['bug2 waive cannot hide a missing inline handler', { corpus: {}, files: { 'p.html': '<button onclick="goneZq()">x</button>' }, waive: { goneZq: 'x' } }, false, [/goneZq/, 'refuted']],
        ['bug2 waive without a reason string is ignored', { corpus: LONE, files: ['src/js/lone.js'], waive: { orphanFn: true } }, false, [/orphanFn.*waive ignored/, 'refuted']],
        ['bug2 legit waive of an unwired fn records the reason', { corpus: LONE, files: ['src/js/lone.js'], waive: { orphanFn: 'tool registry' } }, true, [/orphanFn.*waived: tool registry/, 'unverified']],
        ['bug2 entryPoint of an unwired fn', { corpus: LONE, files: ['src/js/lone.js'], entryPoints: ['orphanFn'] }, true, [/orphanFn.*declared entry point/, 'unverified']],
        ['bug3 grep throws -> unverified + ioErrors, no crash', { io: mkIO({ 'a.js': 'function foo() { return 1; }\nfoo();\n' }, { grep: boom }), files: ['a.js'], prose: '\x60foo()\x60', cssDir: false }, true, [/io\.grep.*boom/, 'unverified']],
        ['bug3 ls throws', { io: mkIO({ 'a.js': 'var x = 1;\n' }, { ls: boom }), files: ['a.js'] }, true, [/io\.ls/, 'unverified']],
        ['bug3 diff throws', { io: mkIO({ 'a.js': 'function g() { return 1; }\ng();\n' }, { diff: boom }), files: ['a.js'], cssDir: false }, true, [/io\.diff/, 'unverified']],
        ['bug3 invalid exclude regex is a config error, not a crash', { corpus: { 'a.js': 'var x = 1;\n' }, files: ['a.js'], exclude: ['('] }, false, [/opts\.exclude/, 'refuted']],
        ['bug4 listener target with grep unavailable', { io: mkIO({ 'a.js': 'function mount() { el.addEventListener("click", ghostHandler); }\nmount();\n' }, { grep: async function() { return null; } }), files: ['a.js'], cssDir: false }, true, [/listener handler ghostHandler/, 'unverified']],
        ['bug4 listener target with grep capped', { io: mkIO({ 'a.js': 'function mount() { el.addEventListener("click", ghostHandler); }\nmount();\n' }, { grep: async function() { var a = []; for (var i = 0; i < 100; i++) a.push({ file: 'src/x' + i + '.js', line: 1, text: 'call(ghostHandler);' }); a.truncated = true; return a; } }), files: ['a.js'], cssDir: false }, true, [/listener handler ghostHandler/, 'unverified']],
        ['bug4 inline HTML handler with grep unavailable', { io: mkIO({}, { grep: async function() { return null; } }), files: { 'p.html': '<button onclick="ghostH()">x</button>' }, cssDir: false }, true, [/ghostH\(\) is defined/, 'unverified']],
        ['bug5 ref only in a // comment is unwired', { corpus: { 'a.js': 'function lonely() { return 1; }\n// lonely is called from nowhere\n' }, files: ['a.js'], functions: ['lonely'] }, false, [/lonely.*referenced/, 'refuted']],
        ['bug5 ref only in a block comment is unwired', { corpus: { 'a.js': 'function lonely() { return 1; }\n/*\n lonely()\n*/\n' }, files: ['a.js'], functions: ['lonely'] }, false, [/lonely.*referenced/, 'refuted']],
        ['bug5 ref only in .md is unwired', { corpus: { 'a.js': 'function lonely() { return 1; }\n', 'README.md': 'lonely()\n' }, files: ['a.js'], functions: ['lonely'] }, false, [/lonely.*referenced/, 'refuted']],
        ['bug5 ref only in a string is unwired', { corpus: { 'a.js': 'function lonely() { return 1; }\nvar s = "lonely";\n' }, files: ['a.js'], functions: ['lonely'] }, false, [/lonely.*referenced/, 'refuted']],
        ['bug5 self-recursion is not wiring', { corpus: { 'a.js': 'function fact(n) {\n  return n ? n * fact(n - 1) : 1;\n}\n' }, files: ['a.js'], functions: ['fact'] }, false, [/fact.*referenced/, 'refuted']],
        ['bug5 test-only refs are unverified', { corpus: { 'a.js': 'function lonely() { return 1; }\n', 'test/a.test.js': 'lonely();\n' }, files: ['a.js'], functions: ['lonely'] }, true, [/lonely.*referenced only in tests/, 'unverified']],
        ['bug5 a real code ref still verifies', { corpus: { 'w.js': 'function wiredZ() { return 1; }\nwiredZ();\n' }, files: ['w.js'], prose: '\x60wiredZ()\x60 at \x60w.js:1\x60' }, true, [/wiredZ \(w\.js:1\) is referenced/, 'verified']],
        ['bug6 io.available false -> file citation unverified', { io: mkIO({}, { available: async function() { return false; } }), prose: '\x60a.js:1\x60', cssDir: false }, true, [/a\.js.*workspace unavailable/, 'unverified']],
        ['bug7 static async method', { corpus: { 'c.js': 'class C {\n  static async load(a) {\n    return a;\n  }\n}\nC.load(1);\n' }, files: ['c.js'], prose: '\x60load()\x60', functions: ['load'] }, true, [/load \(c\.js:2\) is referenced/, 'verified']],
        ['bug7 getter', { corpus: { 'g.js': 'var o = {\n  get size() {\n    return 1;\n  }\n};\nconsole.log(o.size);\n' }, files: ['g.js'], prose: '\x60size()\x60', functions: ['size'] }, true, [/size\(\)\x60 exists/, 'verified']],
        ['bug7 *generator method', { corpus: { 'g.js': 'var o = {\n  *gen() {\n    yield 1;\n  }\n};\no.gen();\n' }, files: ['g.js'], prose: '\x60gen()\x60', functions: ['gen'] }, true, [/gen\(\)\x60 exists/, 'verified']],
        ['bug7 async *generator method', { corpus: { 'q.js': 'class Q {\n  async *items() {\n    yield 1;\n  }\n}\nnew Q().items();\n' }, files: ['q.js'], prose: '\x60items()\x60', functions: ['items'] }, true, [/items\(\)\x60 exists/, 'verified']],
        ['bug7 default param with parens (method)', { corpus: { 'f.js': 'var o = {\n  fmt(a = String(1)) {\n    return a;\n  }\n};\no.fmt();\n' }, files: ['f.js'], prose: '\x60fmt()\x60', functions: ['fmt'] }, true, [/fmt\(\)\x60 exists/, 'verified']],
        ['bug7 default param with parens (arrow)', { corpus: { 'f.js': 'var fmt2 = (a = String(1)) => {\n  return a;\n};\nfmt2();\n' }, files: ['f.js'], functions: ['fmt2'] }, true, [/fmt2 \(f\.js:1\) is referenced/, 'verified']],
        ['bug8 export alias API.runZ()', { corpus: { 'api.js': 'function drRunZ() { return 1; }\nvar API = {\n  runZ: drRunZ\n};\nmodule.exports = API;\n' }, prose: '\x60API.runZ()\x60' }, true, [/exported alias runZ -> drRunZ/, 'verified']],
        ['bug8 module.exports = {alias}', { corpus: { 'm2.js': 'function helperZ() {}\nmodule.exports = {\n  aliasZ: helperZ,\n  helperZ\n};\n' }, prose: '\x60aliasZ()\x60' }, true, [/exported alias aliasZ -> helperZ/, 'verified']],
        ['bug9 0 mutants is unverified, not verified', { corpus: { 'k.js': 'function k() { return 1; }\nk();\n' }, files: ['k.js'], mutation: [{ file: 'k.js', fn: 'k', cases: [{ args: [], expect: 1 }] }] }, true, [/k checks kill.*0 valid mutants/, 'unverified']],
        ['bug9 probe missed arms reach the ledger when fn is not analysed', { corpus: { 'p.js': PICK }, files: ['p.js'], functions: ['other'], probes: [{ file: 'p.js', fn: 'pick', inputs: [[1]] }] }, true, [/pick: every probed branch arm.*missed/, 'unverified']],
        ['bug9 xss edge input on a pure string helper is not a DOM failure', { corpus: { 's.js': 'function trimZ(s) { return String(s).trim(); }\ntrimZ("a");\n' }, files: ['s.js'], probes: [{ file: 's.js', fn: 'trimZ', inputs: [['a']], edge: true }] }, true, null, function(r) { assert.strictEqual(r.probes[0].domCheck, false); }],
        ['bug9 a naive HTML renderer still fails the xss edge', { corpus: { 'r.js': 'function card(s) { return "<b>" + s + "</b>"; }\ncard("a");\n' }, files: ['r.js'], probes: [{ file: 'r.js', fn: 'card', inputs: [['a']], edge: true, only: ['xss'] }] }, false, [/card\(arg0=xss\).*xss/, 'refuted']],
        ['bug10 definition only in a comment does not verify', { corpus: { 'a.js': '// function ghostDef() {}\n' }, prose: '\x60ghostDef()\x60' }, false, [/ghostDef/, 'refuted']],
        ['bug10 definition only in .md does not verify', { corpus: { 'a.js': 'var x = 1;\n', 'doc.md': 'function ghostMd() {}\n' }, prose: '\x60ghostMd()\x60' }, false, [/ghostMd/, 'refuted']],
        ['bug10 id defined only in .md is unverified', { corpus: { 'a.js': 'var x = 1;\n', 'doc.md': '<div id="ghostIdZ"></div>\n' }, prose: '\x60#ghostIdZ\x60' }, true, [/ghostIdZ/, 'unverified']],
        ['bug10 CSS-only change gets a parse row', { corpus: {}, files: { 'a.css': '.x { color: red; }' } }, true, [/a\.css CSS parses/, 'verified']]
    ];
    test('adversarial matrix (v1.3.0): exact gate + row status per repro, 0 false PASS, 0 crash', async function() {
        var d = await load(), bad = [];
        for (var i = 0; i < MATRIX.length; i++) {
            var c = MATRIX[i], rep = await d.run(c[1]);
            if (!rep.gate || rep.error) { bad.push(c[0] + ': crashed ' + rep.error); continue; }
            if (rep.gate.pass !== c[2]) bad.push(c[0] + ': gate ' + rep.gate.pass + ' (refuted: ' + rep.gate.refuted.join(' ; ').slice(0, 200) + ')');
            if (c[3]) { var st = rowOf(rep, c[3][0]).map(function(r) { return r.status; }); if (st.indexOf(c[3][1]) < 0) bad.push(c[0] + ': row ' + c[3][0] + ' status [' + st.join(',') + '] want ' + c[3][1]); }
            if (c[4]) { try { c[4](rep); } catch (e) { bad.push(c[0] + ': ' + e.message); } }
        }
        assert.deepStrictEqual(bad, []);
    }, { tags: ['unit'] });

    test('bug1: 0 ledger rows with files given fails the gate (defensive net)', async function() {
        var d = await load(), L = d.ledger({ filesGiven: true });
        assert.strictEqual(L.gate.pass, false);
        assert.match(L.gate.refuted[0], /0 rows/);
        assert.strictEqual(d.ledger({}).gate.pass, false, 'v1.3.1 round 3: an empty report verifies nothing, so it fails too');
    }, { tags: ['unit'] });

    test('bug3: run() never throws; an internal error is a refuted row', async function() {
        var d = await load(), rep = await d.run({ corpus: {}, files: ['a.js'], io: { read: async function() { return 'x'; }, grep: async function() { return []; } }, probes: [null] });
        assert.strictEqual(rep.gate.pass, false);
        assert.match(rep.gate.refuted.join(' '), /internal error/);
    }, { tags: ['unit'] });

    test('bug7/8: findFunctions sees static/async/get/set/generator methods and nested default params; exportAliases resolves', async function() {
        var d = await load();
        var src = 'class A {\n  static async s(a = f()) {\n  }\n  get g() {\n  }\n  set g(v) {\n  }\n  *gen() {\n  }\n  async *ag() {\n  }\n}\nvar ar = (a = f(1)) => {\n};\n';
        var names = d.findFunctions(src).map(function(f) { return f.name; });
        ['s', 'g', 'gen', 'ag', 'ar'].forEach(function(n) { assert.ok(names.indexOf(n) >= 0, n + ' in ' + names.join()); });
        assert.match(d.fnSource(src, d.findFunctions(src).filter(function(f) { return f.name === 'ag'; })[0]), /^async function\* ag\(/);
        var al = d.exportAliases('var API = {\n  run: drRun,\n  mask\n};\nmodule.exports = API;\n');
        assert.deepStrictEqual([al.run.target, al.run.line, al.mask.target], ['drRun', 2, 'mask']);
        assert.strictEqual(d.exportAliases('var cfg = { run: drRun };\n').run, undefined, 'a non-exported local object is not an API');
    }, { tags: ['unit'] });

    test('bug8 dogfood: prose citing D.run() / D.ledger() verifies against the real module', async function() {
        // v1.4.0: D is a runFile() result, not a repo object, so D.x() is unverified; DEROULEMENT.x() resolves to the literal
        var d = await load(), rep = await d.run({ prose: '\x60D.parseGateJs()\x60 and \x60DEROULEMENT.parseGateJs()\x60', cssDir: false });
        assert.deepStrictEqual(rep.symbols.map(function(s) { return s.status; }), ['unverified', 'verified']);
    }, { tags: ['unit'] });
    // v1.4.0 round 4: each case was a false PASS before the fix
    var MATRIX5 = [
        ['1a D.drRun() when D = {run: drRun} is unverified', { corpus: { 'a.js': 'function drRun() {}\nvar D = { run: drRun };\nD.run();\n' }, prose: '\x60D.drRun()\x60', cssDir: false }, true, [/drRun/, 'unverified']],
        ['1b API.run() via the literal key is verified', { corpus: { 'a.js': 'function drRun() {}\nvar API = { run: drRun };\nmodule.exports = API;\n' }, prose: '\x60API.run()\x60', cssDir: false }, true, [/run/, 'verified']],
        ['2a const ghostC = 5 is not callable', { corpus: { 'a.js': 'const ghostC = 5;\n' }, prose: '\x60ghostC()\x60', cssDir: false }, false, [/ghostC/, 'refuted']],
        ['2b const ghostK = make() is unverified', { corpus: { 'a.js': 'function make() {}\nconst ghostK = make();\n' }, prose: '\x60ghostK()\x60', cssDir: false }, true, [/ghostK/, 'unverified']],
        ['3 identifier only in JSON is unverified', { corpus: { 'cfg.json': '{"jsonOnly": 1}\n' }, prose: '\x60jsonOnly\x60', cssDir: false }, true, [/jsonOnly/, 'unverified']],
        ['3 CSS content string ident is unverified', { corpus: { 'a.css': '.x::before { content: "cssStrIdent"; }\n' }, prose: '\x60cssStrIdent\x60', cssDir: false }, true, [/cssStrIdent/, 'unverified']],
        ['4 key/param-only mentions are not wiring', { corpus: { 'src/h.js': 'function helperK() { return 1; }\nfunction p(helperK) { return 1; }\nvar o = { helperK: 1 };\nvar q = helperK => 1;\np(); q(); o;\n' }, files: ['src/h.js'], functions: ['helperK'], cssDir: false }, false, [/helperK .*referenced/, 'refuted']],
        ['4 a real call is wiring', { corpus: { 'src/h.js': 'function helperK() { return 1; }\nfunction p(helperK) { return 1; }\nhelperK();\np();\n' }, files: ['src/h.js'], functions: ['helperK'], cssDir: false }, true, [/helperK .*referenced/, 'verified']],
        ['9 "/*" inside a CSS string does not hide the next rule', { corpus: { 'a.css': '.a::before { content: "/*"; }\n.b { color: red; }\n' }, prose: '\x60.b\x60', cssDir: false }, true, [/\.b/, 'verified']],
        ['6 exclude removing every file is an unverified config row', { corpus: { 'src/a.js': 'function a() {}\na();\n' }, files: ['src/a.js'], exclude: [/.*/], cssDir: false }, true, [/opts\.exclude leaves/, 'unverified']],
        ['7 onclick obj.ghostM() is unverified', { corpus: { 'a.js': 'var obj = {};\n' }, files: { 'p.html': '<button onclick="obj.ghostM()">x</button>' }, cssDir: false }, true, [/obj\.ghostM/, 'unverified']],
        ['7 onclick obj.realM() with the member is not unverified', { corpus: { 'a.js': 'var obj = { realM: function () {} };\n' }, files: { 'p.html': '<button onclick="obj.realM()">x</button>' }, cssDir: false }, true, [/p\.html HTML is well-formed/, 'verified']],
        ['7 onclick window.ghostW2() is refuted', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="window.ghostW2()">x</button>' }, cssDir: false }, false, [/ghostW2/, 'refuted']],
        ['7 onclick runFile() (sandbox global) is refuted', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="runFile()">x</button>' }, cssDir: false }, false, [/runFile/, 'refuted']],
        ['7 onclick alert(1) passes', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="alert(1)">x</button>' }, cssDir: false }, true, [/p\.html HTML is well-formed/, 'verified']],
        ['7 qualified listener handler obj.ghostL is unverified', { corpus: { 'src/l.js': 'var obj = {};\ndocument.body.addEventListener("click", obj.ghostL);\n' }, files: ['src/l.js'], cssDir: false }, true, [/listener handler obj\.ghostL/, 'unverified']],
        ['8 handler only inside a template string is refuted', { corpus: { 'src/m.js': 'chrome.runtime.sendMessage({ type: "tplMsg" });\nvar t = \x60if (msg.type === "tplMsg") go();\x60;\n' }, files: ['src/m.js'], cssDir: false }, false, [/tplMsg.*has a handler/, 'refuted']],
        ['8 getElementById inside a string is not a use', { corpus: { 'src/g.js': 'var s = "document.getElementById(\'ghostStrId\')";\n' }, files: ['src/g.js'], cssDir: false }, true, [/src\/g\.js parses/, 'verified']],
        // reviewer round (v1.4.0 adversarial review, cheap fixes R1-R10)
        ['R1 onclick document.nope() is refuted', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="document.nope()">x</button>' }, cssDir: false }, false, [/document\.nope/, 'refuted']],
        ['R1 onclick Math.nope() is refuted', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="Math.nope()">x</button>' }, cssDir: false }, false, [/Math\.nope/, 'refuted']],
        ['R1 onclick Math.max(1) passes', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<button onclick="Math.max(1)">x</button>' }, cssDir: false }, true, [/p\.html HTML is well-formed/, 'verified']],
        ['R2 obj.m = 5 is not a callable member', { corpus: { 'a.js': 'var obj = {};\nobj.m = 5;\nfunction m() {}\nm();\n' }, prose: '\x60obj.m()\x60', cssDir: false }, true, [/obj\.m\(\)/, 'unverified']],
        ['R2 {a: 1, m: 5} is not a callable member', { corpus: { 'a.js': 'var obj = { a: 1, m: 5 };\nfunction m() {}\nm();\n' }, prose: '\x60obj.m()\x60', cssDir: false }, true, [/obj\.m\(\)/, 'unverified']],
        ['R2 obj.m = function () {} is verified', { corpus: { 'a.js': 'var obj = {};\nobj.m = function () {};\nobj.m();\n' }, prose: '\x60obj.m()\x60', cssDir: false }, true, [/obj\.m\(\)/, 'verified']],
        ['R3 a call inside a value is not a key', { corpus: { 'a.js': 'var obj = {\n  a: cond ? m() : 0\n};\nfunction m() {}\n' }, prose: '\x60obj.m()\x60', cssDir: false }, true, [/obj\.m\(\)/, 'unverified']],
        ['R4 app.obj.m() is not resolved by the last segment', { corpus: { 'a.js': 'var app = {};\napp.obj = { a: 1 };\nvar obj = {\n  m() {}\n};\n' }, prose: '\x60app.obj.m()\x60', cssDir: false }, true, [/app\.obj\.m/, 'unverified']],
        ['R5 switch (typeof v) is not a message handler', { corpus: { 'src/m.js': 'chrome.runtime.sendMessage({ type: "fooT" });\nswitch (typeof v) { case "fooT": break; }\n' }, files: ['src/m.js'], cssDir: false }, false, [/fooT.*has a handler/, 'refuted']],
        ['R6 an attribute-selector string is not a class rule', { corpus: { 's.css': '[data-x=".ghostA"] { color: red; }\n', 'src/c.js': 'el.classList.add("ghostA");\n' }, files: ['src/c.js', 's.css'], cssDir: false }, true, [/ghostA.*has a CSS rule/, 'unverified']],
        ['R7 / after a++ is division, not a regex', { corpus: { 'a.js': 'var a = 1;\nvar n = a++ / 2; var t = "/"; var s = "function ghostR() {}";\n' }, prose: '\x60ghostR()\x60', cssDir: false }, false, [/ghostR/, 'refuted']],
        ['R8 var id = "x" is not an id definition', { corpus: { 'src/i.js': 'var id = "ghostPanel";\ndocument.getElementById("ghostPanel");\n' }, files: ['src/i.js'], cssDir: false }, false, [/ghostPanel/, 'refuted']],
        ['R9 a script inside <template> defines no handler', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<template><script>function ghostT() {}</script></template>\n<button onclick="ghostT()">x</button>' }, cssDir: false }, false, [/ghostT/, 'refuted']],
        ['R9 a prose function defined only inside <template> is refuted', { corpus: { 'p.html': '<template><script>function ghostT2() {}</script></template>\n' }, prose: '\x60ghostT2()\x60', cssDir: false }, false, [/ghostT2/, 'refuted']],
        ['R10 a module-script function is not an onclick global', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<script type="module">function ghostMod() {}</script>\n<button onclick="ghostMod()">x</button>' }, cssDir: false }, false, [/ghostMod/, 'refuted']],
        ['R10 a module script that publishes window.okMod passes', { corpus: { 'a.js': 'var z = 1;\n' }, files: { 'p.html': '<script type="module">function okMod() {}\nwindow.okMod = okMod;</script>\n<button onclick="okMod()">x</button>' }, cssDir: false }, true, [/p\.html HTML is well-formed/, 'verified']],
        ['R-alias prose constructor() is not an export alias', { corpus: { 'a.js': 'var o = {};\nmodule.exports = { a: 1 };\n' }, prose: '\x60constructor()\x60', cssDir: false }, true, [/constructor\(\)[^|]*\| (?!.*exported as)/, 'unverified']]
    ];
    test('R-null: checkSymbols(null) returns [] instead of throwing', async function() {
        var d = await load();
        assert.deepStrictEqual(await d.checkSymbols(null), []);
    }, { tags: ['unit'] });
    test('10: crossRefs(null), expression arrows and bad probe sources never throw', async function() {
        var d = await load(), x = await d.crossRefs(null);
        assert.ok(x && x.error, 'crossRefs(null) returns an error');
        assert.strictEqual(d.ledger({ crossRefs: x }).gate.pass, false);
        var p = await d.probe('x=>1', { inputs: [[1]] });
        assert.strictEqual(p.runs[0].result, '1');
        var bad = await d.probe('nope');
        assert.strictEqual(bad.ok, false); assert.ok(Array.isArray(bad.runs));
    }, { tags: ['unit'] });
    test('review-5 matrix (v1.4.0 round 4): qualified names, non-callable vars, data files, params, CSS strings', async function() {
        var d = await load(), bad = [];
        for (var i = 0; i < MATRIX5.length; i++) {
            var c = MATRIX5[i], rep = await d.run(c[1]);
            if (!rep.gate || rep.error) { bad.push(c[0] + ': crashed ' + rep.error); continue; }
            if (rep.gate.pass !== c[2]) bad.push(c[0] + ': gate ' + rep.gate.pass + ' (refuted: ' + rep.gate.refuted.join(' ; ').slice(0, 200) + ')');
            var st = rowOf(rep, c[3][0]).map(function(r) { return r.status; }); if (st.indexOf(c[3][1]) < 0) bad.push(c[0] + ': row status [' + st.join(',') + '] want ' + c[3][1]);
        }
        assert.deepStrictEqual(bad, []);
    }, { tags: ['unit'] });
    test('5: opts.functions is a union with the diff; functionsOnly restricts to them', async function() {
        var d = await load(), src = 'function aa() { return 1; }\nfunction bb() { return 2; }\naa(); bb();\n', diff = '@@ -1,1 +1,1 @@\n-x\n+function aa() { return 1; }\n';
        var names = function(r) { return r.changedFunctions.map(function(c) { return c.name; }).sort(); };
        assert.deepStrictEqual(names(await d.run({ corpus: { 'a.js': src }, files: ['a.js'], diff: diff, functions: ['bb'], cssDir: false })), ['aa', 'bb']);
        assert.deepStrictEqual(names(await d.run({ corpus: { 'a.js': src }, files: ['a.js'], diff: diff, functions: ['bb'], functionsOnly: true, cssDir: false })), ['bb']);
    }, { tags: ['unit'] });
    // ---------- v1.3.1 review-3 matrix: one repro per finding, exact row status + gate ----------
    var CMTS = {}; for (var ci = 0; ci < 22; ci++) CMTS['src/js/c' + ci + '.js'] = '/*\n helper()\n*/\n';
    var MATRIX3 = [
        ['f1 multi-line doc comment is not a definition', { corpus: { 'a.js': '/**\n * function ghost() old\n */\n' }, prose: '\x60ghost()\x60' }, false, [/ghost\(\)/, 'refuted']],
        ['f1 template text is not a definition', { corpus: { 'a.js': 'var t = \x60\nfunction ghostT() {}\n\x60;\n' }, prose: '\x60ghostT()\x60' }, false, [/ghostT/, 'refuted']],
        ['f1 onclick resolved by a comment-only def fails', { corpus: { 'a.js': '/*\nfunction ghostH() {}\n*/\n' }, files: { 'p.html': '<button onclick="ghostH()">x</button>' } }, false, [/ghostH/, 'refuted']],
        ['f2 id only in a comment is refuted', { corpus: { 'a.js': '// el.id="ghostPanel"\n' }, prose: '\x60#ghostPanel\x60' }, false, [/ghostPanel/, 'refuted']],
        ['f2 CSS class only in a CSS comment is refuted', { corpus: { 'a.css': '/* .ghostCls */\n.real { color: red; }\n' }, prose: '\x60.ghostCls\x60' }, false, [/ghostCls/, 'refuted']],
        ['f2 identifier only in comments is refuted', { corpus: { 'a.js': '/*\n ghostIdent\n*/\n' }, prose: '\x60ghostIdent\x60' }, false, [/ghostIdent/, 'refuted']],
        ['f2 identifier only in a string is unverified', { corpus: { 'a.js': 'var s = "ghostStr";\n' }, prose: '\x60ghostStr\x60' }, true, [/ghostStr/, 'unverified']],
        ['f3 HTML body text is not wiring', { corpus: { 'src/js/h.js': 'function helper() { return 1; }\n', 'p.html': '<p>helper</p>\n' }, files: ['src/js/h.js'], functions: ['helper'] }, false, [/helper .*referenced/, 'refuted']],
        ['f3 <script> string is not wiring', { corpus: { 'src/js/h.js': 'function helper() { return 1; }\n', 'p.html': '<script>var s = "helper()";</script>\n' }, files: ['src/js/h.js'], functions: ['helper'] }, false, [/helper .*referenced/, 'refuted']],
        ['f4 22 comment-only files are not wiring', { corpus: Object.assign({ 'src/js/h.js': 'function helper() { return 1; }\n' }, CMTS), files: ['src/js/h.js'], functions: ['helper'] }, false, [/helper .*referenced/, 'refuted']],
        ['f5 duplicate id inside <template> fails', { corpus: {}, files: { 'p.html': '<template><div id="dupT"></div><div id="dupT"></div></template>' } }, false, [/dupT/, 'refuted']],
        ['f6 onclick="assign()" is not a builtin handler', { corpus: {}, files: { 'p.html': '<button onclick="assign()">x</button>' } }, false, [/assign/, 'refuted']],
        ['f7 waive cannot excuse an invented listener handler', { corpus: { 'src/js/l.js': 'function init() { document.body.addEventListener("click", ghostHandler); }\ninit();\n' }, files: ['src/js/l.js'], waive: { ghostHandler: 'x' } }, false, [/listener handler ghostHandler/, 'refuted']],
        ['f7 waive cannot excuse an invented symbol row', { corpus: { 'a.js': 'var a = 1;\n' }, prose: '\x60ghostW()\x60', waive: { ghostW: 'dynamic' } }, false, [/ghostW.*waive ignored/, 'refuted']],
        ['f8 exclude-only definition does not verify', { corpus: { 'fixtures/x.js': 'function exOnly() {}\n' }, prose: '\x60exOnly()\x60', exclude: [/^fixtures\//] }, true, [/exOnly/, 'unverified']],
        ['f9 opts.ghost = 3 is not a definition', { corpus: { 'a.js': 'var opts = {};\nopts.ghost = 3;\n' }, prose: '\x60ghost()\x60' }, false, [/ghost\(\)/, 'refuted']],
        ['f10 unclosed CSS brace fails', { corpus: {}, files: { 'a.css': '.a { color: red;\n.b { color: blue; }\n' } }, false, [/a\.css CSS parses/, 'refuted']],
        ['f10 dropped CSS block is unverified', { corpus: {}, files: { 'a.css': '.a { color: red; }\n.b::-zz-bogus { color: blue; }\n' } }, true, [/a\.css CSS parses/, 'unverified']],
        ['f11 unawaited rejected stub is reported as threw', { corpus: { 'm.js': 'function f() { save(); return 1; }\nf();\n' }, files: ['m.js'], cssDir: false, probes: [{ file: 'm.js', fn: 'f', inputs: [[]], stubs: { save: function() { return Promise.reject(new Error('nope')); } } }] }, true, [/f\(run1\) does not throw.*UnhandledRejection/, 'unverified']],
        ['f13 malformed grep [null] is an ioError + unverified row', { io: mkIO({ 'a.js': 'var a = 1;\n' }, { grep: async function() { return [null]; } }), prose: '\x60ghostN()\x60', cssDir: false }, true, [/ghostN/, 'unverified'], function(r) { assert.ok(r.ioErrors.length >= 1, 'ioError recorded'); }]
    ];
    test('review-3 matrix (v1.3.1): exact gate + row status per finding, 0 false PASS, 0 crash', async function() {
        var d = await load(), bad = [];
        for (var i = 0; i < MATRIX3.length; i++) {
            var c = MATRIX3[i], rep = await d.run(c[1]);
            if (!rep.gate || rep.error) { bad.push(c[0] + ': crashed ' + rep.error); continue; }
            if (rep.gate.pass !== c[2]) bad.push(c[0] + ': gate ' + rep.gate.pass + ' (refuted: ' + rep.gate.refuted.join(' ; ').slice(0, 200) + ')');
            var st = rowOf(rep, c[3][0]).map(function(r) { return r.status; }); if (st.indexOf(c[3][1]) < 0) bad.push(c[0] + ': row status [' + st.join(',') + '] want ' + c[3][1]);
            if (c[4]) { try { c[4](rep); } catch (e) { bad.push(c[0] + ': ' + e.message); } }
        }
        assert.deepStrictEqual(bad, []);
    }, { tags: ['unit'] });

    test('f12: an unknown row status counts as refuted and fails the gate', async function() {
        var d = await load(), L = d.ledger({ symbols: [{ raw: 'x()', kind: 'function', name: 'x', status: 'bogus', evidence: 'e' }] });
        assert.strictEqual(L.gate.pass, false); assert.strictEqual(L.counts.refuted, 1); assert.match(L.rows[0].evidence, /unknown status/);
    }, { tags: ['unit'] });

    // review round 3 (v1.3.1 adversarial set): each case failed (false PASS / hang / false FAIL / throw) before the fix
    var W = 'function wired() { return 1; }\nwired();\n';
    var MATRIX4 = [
        ['r1 never-settling async probe does not hang run()', { corpus: { 'a.js': 'async function wait() { await new Promise(function () {}); }\nwait();\n' }, files: ['a.js'], cssDir: false, probes: [{ file: 'a.js', fn: 'wait', timeoutMs: 150 }] }, true, [/wait\(run1\) does not throw/, 'unverified'], function(r) { assert.match(r.probes[0].runs[0].threw, /ProbeTimeout/); }],
        ['r2 `await ghost()` prose token is checked', { corpus: { 'a.js': W }, files: ['a.js'], cssDir: false, prose: '\x60await ' + ghost('p') + '()\x60' }, false, [new RegExp(ghost('p')), 'refuted']],
        ['r2 `ghost();` prose token is checked', { corpus: { 'a.js': W }, files: ['a.js'], cssDir: false, prose: '\x60' + ghost('q') + '();\x60' }, false, [new RegExp(ghost('q')), 'refuted']],
        ['r2 `new Ghost()` prose token is checked', { corpus: { 'a.js': W }, files: ['a.js'], cssDir: false, prose: '\x60new ' + ghost('R') + '()\x60' }, false, [new RegExp(ghost('R')), 'refuted']],
        ['r5 file:0 citation is refuted', { corpus: { 'a.js': W }, files: ['a.js'], cssDir: false, prose: '\x60a.js:0\x60' }, false, [/a\.js:0/, 'refuted']],
        ['r8 files as a string is one path', { corpus: { 'a.js': W }, files: 'a.js', cssDir: false }, true, [/a\.js parses/, 'verified'], function(r) { assert.ok(!r.ledger.rows.some(function(x) { return /^\d+ is checked/.test(x.claim); }), 'no per-character rows'); }],
        ['r8 empty run is refuted', {}, false, [/at least one claim/, 'refuted']],
        ['r14 broken multi-line import fails the parse gate', { corpus: {}, files: { 'a.js': 'import { a, b from \'./x.js\';\nfunction broken( {\n' } }, false, [/a\.js parses/, 'refuted']],
        ['r16 hashbang, export * and import.meta parse', { corpus: {}, files: { 'a.js': '#!/usr/bin/env node\nexport * from \'./x.js\';\nvar u = import.meta.url;\n' } }, true, [/a\.js parses/, 'verified']],
        ['r16 JSON / x-template scripts are not compiled', { corpus: {}, cssDir: false, files: { 'a.html': '<script type="application/ld+json">{"a": 1}</script><script type="text/x-template"><div>{{ x }}</div></script>' } }, true, [/a\.html HTML is well-formed/, 'verified']]
    ];
    test('review-4 matrix (v1.3.1 round 3): hang, skipped prose, line 0, bad files, module syntax, script types', async function() {
        var d = await load(), bad = [];
        for (var i = 0; i < MATRIX4.length; i++) {
            var c = MATRIX4[i], rep = await d.run(c[1]);
            if (!rep.gate || rep.error) { bad.push(c[0] + ': crashed ' + rep.error); continue; }
            if (rep.gate.pass !== c[2]) bad.push(c[0] + ': gate ' + rep.gate.pass + ' (refuted: ' + rep.gate.refuted.join(' ; ').slice(0, 200) + ')');
            var st = rowOf(rep, c[3][0]).map(function(r) { return r.status; }); if (st.indexOf(c[3][1]) < 0) bad.push(c[0] + ': row status [' + st.join(',') + '] want ' + c[3][1]);
            if (c[4]) { try { c[4](rep); } catch (e) { bad.push(c[0] + ': ' + e.message); } }
        }
        assert.deepStrictEqual(bad, []);
    }, { tags: ['unit'] });

    test('r12/r13/r17: 0-arm probe is not verified, flaky mutation check is refuted, null input does not throw', async function() {
        var d = await load();
        var tern = 'function t(a, b, c, d, e, f) { return (a ? 1 : 2) + (b ? 1 : 2) + (c ? 1 : 2) + (d ? 1 : 2) + (e ? 1 : 2) + (f ? 1 : 2); }\nt();\n';
        var rep = await d.run({ corpus: { 't.js': tern }, files: ['t.js'], cssDir: false, functions: ['t'], probes: [{ file: 't.js', fn: 't', inputs: [[1, 0, 1, 0, 1, 0]] }] });
        var br = rowOf(rep, /t: every probed branch arm/); assert.ok(br.length && br[0].status === 'unverified', 'branch row ' + JSON.stringify(br));
        var n = 0, rep2 = await d.run({ corpus: { 'm.js': 'function m(x) { if (x > 1) return 1; return 0; }\nm();\n' }, files: ['m.js'], cssDir: false, mutation: [{ file: 'm.js', fn: 'm', check: function() { return n++ === 0; } }] });
        var mr = rowOf(rep2, /m mutation check passes on the original/); assert.ok(mr.length && mr[0].status === 'refuted', 'mutation row ' + JSON.stringify(mr));
        assert.strictEqual(d.ledger(null).gate.pass, false); assert.match(d.format(null), /Claims ledger: FAIL/);
    }, { tags: ['unit'] });
});
