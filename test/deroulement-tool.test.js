// deroulement.js as a SKILL TOOL (deroulement_check): the real skills engine must parse it
// (no "no TOOL_DEFINITION — skipped" path), in the SW realm too (eval blocked -> JSON fallback),
// and the tool must run the way the skill sandbox runs it: `<code>;\nreturn await <name>(<json>)`.
var DRT_PATH = 'skills/feature-deroulement/deroulement.js';
describe('deroulement_check skill tool (skills/feature-deroulement/deroulement.js)', function() {
    async function engine(content, isWorker) {
        var g = {
            window: fakeWindow(), chrome: fakeChrome(), activeSkills: {}, skills: {},
            getSetting: async function(k, d) { return d; }, setSetting: async function() {},
            skillAssetsStoreName: 'skill_assets',
            openDatabase: async function() {
                return { transaction: function() { return { objectStore: function() { return {
                    getAll: function() {
                        var req = { result: [{ skillId: 'feature-deroulement', filename: 'deroulement.js', type: 'js', content: content }] };
                        Promise.resolve().then(function() { if (req.onsuccess) req.onsuccess(); });
                        return req;
                    }
                }; } }; } };
            },
            renderSkillsList: function() {}, saveSkill: async function() {},
            Platform: { isWorker: !!isWorker }
        };
        return loadModules(['src/js/core/140-skills-engine.js'], { lenient: true, globals: g });
    }
    async function sandboxCall(code, args) {
        // Same code shape as offscreen-helper.js runSkillSandbox / 140-skills-engine.js page path.
        var AF = Object.getPrototypeOf(async function() {}).constructor;
        return new AF(code + ';\nreturn await deroulement_check(' + JSON.stringify(args) + ');')();
    }

    test('loadSkillTools registers deroulement_check (not skipped, no errors)', async function() {
        var src = await loadFile(DRT_PATH);
        var m = await engine(src, false);
        var r = await m.loadSkillTools('feature-deroulement');
        assert.deepStrictEqual(r.skipped, []);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.loaded, 1);
        var t = m.skillTools['feature-deroulement'].deroulement_check;
        assert.strictEqual(t.name, 'deroulement_check');
        assert.strictEqual(t.code, src);
    }, { tags: ['unit'], timeout: 10000 });

    test('definition shape: JSON-schema params cover the run() args; CSP JSON fallback equals eval', async function() {
        var src = await loadFile(DRT_PATH);
        var m = await engine(src, true);
        var def = m.parseSkillToolFile(src).definition;
        assert.strictEqual(def.type, 'function');
        assert.strictEqual(def.function.name, 'deroulement_check');
        var p = def.function.parameters;
        assert.strictEqual(p.type, 'object');
        ['files', 'sources', 'prose', 'workspace', 'corpus', 'diff', 'functions', 'functionsOnly', 'exclude', 'entryPoints',
            'waive', 'cssDir', 'cssFiles', 'probes', 'mutation', 'claims', 'output'].forEach(function(k) {
            assert.ok(p.properties[k] && p.properties[k].type, 'param ' + k);
        });
        assert.deepStrictEqual(p.properties.output.enum, ['summary', 'ledger', 'full']);
        // SW realm: extension CSP blocks eval, so the engine converts the literal to JSON.
        var lit = src.match(/(?:var|const|let)\s+TOOL_DEFINITION\s*=\s*(\{[\s\S]*?\n\});?/)[1];
        assert.deepStrictEqual(JSON.parse(m.jsObjectLiteralToJson(lit)), def);
    }, { tags: ['unit'], timeout: 10000 });

    test('tool call (sandbox code shape) returns a JSON report; bad args are a clean error', async function() {
        var src = await loadFile(DRT_PATH);
        var code = 'function add(a, b) { return a + b; }\nadd(1, 2);\n';
        var ok = await sandboxCall(src, { sources: { 'feature.js': code }, corpus: { 'feature.js': code }, prose: 'On load `add()` sums.', functions: ['add'] });
        assert.strictEqual(ok.success, true);
        assert.strictEqual(ok.gate.pass, true);
        assert.strictEqual(ok.summary.refuted, 0);
        assert.ok(ok.summary.verified >= 2, 'parse + symbol rows verified');
        assert.strictEqual(typeof ok.ledger, 'string');
        assert.strictEqual(ok.report, undefined);
        assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(ok))), JSON.stringify(ok));
        var bad = await sandboxCall(src, { sources: { 'feature.js': code }, corpus: { 'feature.js': code }, prose: '`ghostZqxFn()` runs.' });
        assert.strictEqual(bad.success, true);
        assert.strictEqual(bad.gate.pass, false);
        assert.ok(bad.gate.refuted.some(function(r) { return /ghostZqxFn/.test(r); }));
        var stub = await sandboxCall(src, { sources: { 'f.js': 'function f(x) { if (x) { return g(x); } return 0; }\n' }, corpus: { 'f.js': 'function f(x) { if (x) { return g(x); } return 0; }\nf(1);\n' },
            probes: [{ file: 'f.js', fn: 'f', inputs: [[1], [0]], stubs: { g: 'function (v) { return v * 2; }' } }], output: 'full' });
        assert.strictEqual(stub.success, true);
        assert.ok(stub.report && stub.report.probes[0].ok !== false, JSON.stringify(stub.report && stub.report.probes[0]).slice(0, 300));
        var e1 = await sandboxCall(src, {});
        assert.strictEqual(e1.success, false);
        assert.match(e1.error, /files .* or sources/);
        var e2 = await sandboxCall(src, { files: ['a.js'], output: 'huge' });
        assert.match(e2.error, /output must be/);
        var e3 = await sandboxCall(src, { sources: { 'f.js': code }, probes: [{ file: 'f.js', fn: 'add', stubs: { g: 'function (' } }] });
        assert.match(e3.error, /probes\[0\]\.stubs\.g does not compile/);
    }, { tags: ['unit'], timeout: 20000 });

    test('backward compatible: runFile API unchanged, run:true returns the report', async function() {
        var D = await runFile(DRT_PATH, {});
        ['run', 'branches', 'domPostconditions', 'format', 'ledger', 'probe', 'mutationTest'].forEach(function(k) { assert.strictEqual(typeof D[k], 'function', k); });
        assert.strictEqual(typeof D.tool, 'function');
        assert.strictEqual(D.toolDefinition.function.name, 'deroulement_check');
        var rep = await runFile(DRT_PATH, { run: true, files: { 'a.js': 'function a() {}\na();\n' }, corpus: { 'a.js': 'function a() {}\na();\n' } });
        assert.strictEqual(rep.gate.pass, true);
        assert.ok(Array.isArray(rep.limitations));
    }, { tags: ['unit'], timeout: 10000 });

    test('no DOM (SW-like realm): HTML/DOM checks degrade to unverified with a reason, never throw', async function() {
        var src = await loadFile(DRT_PATH);
        var AF = Object.getPrototypeOf(async function() {}).constructor, mod = { exports: {} };
        // Shadow the DOM globals the helper uses, like a service worker realm.
        var D = await new AF('module', 'exports', 'args', 'DOMParser', 'CSSStyleSheet', src + '\n;return module.exports;')(mod, mod.exports, {}, undefined, undefined);
        var h = D.parseGateHtml('x.html', '<div id="a"></div>');
        assert.strictEqual(h.ok, null);
        assert.match(h.noDom, /DOMParser unavailable/);
        var post = D.domPostconditions('<b>undefined</b>');
        assert.strictEqual(post.ok, null);
        var js = 'function a() { return document.getElementById("a"); }\na();\n';
        var rep = await D.run({ files: { 'x.html': '<div id="a"></div>', 's.css': '.k { color: red; }', 'a.js': js }, corpus: { 'x.html': '<div id="a"></div>', 'a.js': js } });
        var rows = rep.ledger.rows;
        function st(re) { var r = rows.filter(function(x) { return re.test(x.claim); })[0]; return r && r.status; }
        assert.strictEqual(st(/x\.html HTML is well-formed/), 'unverified');
        assert.strictEqual(st(/s\.css CSS parses/), 'unverified');
        assert.strictEqual(st(/#a .*static id definition/), 'unverified');
        assert.strictEqual(rep.summary.refuted, 0);
    }, { tags: ['unit'], timeout: 10000 });
});
