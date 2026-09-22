'use strict';
// Run externally: node build/test-policy-artifacts.test.js
// No extension, npm dependencies, disk writes, or live deployment. Real builder
// entry points run in Node vm with read-only fs and recording write/deploy spies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const nodeSource = read('build/build.js');
const browserSource = read('skills/extension-dev/build.js');
const policySource = read('src/js/core/075-test-run-policy.js');
const quiet = { log() {}, warn() {}, error() {} };
let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function between(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, 'real source markers must exist: ' + start);
    return source.slice(a, b);
}
function guardRegion(source) {
    const start = '// ' + '\u2500'.repeat(3) + ' Write-site ratchet shared logic';
    const end = '// ' + '\u2500'.repeat(3) + ' End write-site ratchet shared logic';
    return between(source, start, end);
}
const guard = vm.createContext({});
vm.runInContext(guardRegion(nodeSource), guard);
assert.equal(guardRegion(nodeSource), guardRegion(browserSource), 'entire synchronized region must match');
function artifacts() {
    return {
        'app.js': policySource, 'sw-bundle.js': policySource,
        'test-run-policy.js': policySource,
        'offscreen.html': read('src/platform/extension/offscreen.html'),
        'offscreen-helper.js': read('src/platform/extension/offscreen-helper.js'),
        'background.js': read('src/platform/extension/background.js'),
        'sandbox.html': read('src/platform/extension/sandbox.html')
    };
}
const faults = [
    ['SW references without declaration', a => { a['sw-bundle.js'] = 'TestRunPolicy.registry.bind(id, key);'; }],
    ['page missing policy', a => { a['app.js'] = 'void 0;'; }],
    ['non-string worker output', a => { a['sw-bundle.js'] = 7; }],
    ['non-string offscreen output', a => { a['offscreen.html'] = {}; }],
    ['data-src is not a script dependency', a => { a['offscreen.html'] = a['offscreen.html'].replace('src="test-run-policy.js"', 'data-src="test-run-policy.js"'); }],
    ['missing standalone', a => { delete a['test-run-policy.js']; }],
    ['different standalone', a => { a['test-run-policy.js'] += '\n// stale'; }],
    ['missing offscreen helper', a => { delete a['offscreen-helper.js']; }],
    ['missing sandbox', a => { delete a['sandbox.html']; }],
    ['missing worker bootstrap', a => { delete a['background.js']; }],
    ['misordered offscreen scripts', a => { a['offscreen.html'] = '<script src="offscreen-helper.js"></script><script src="test-run-policy.js"></script>'; }],
    ['missing offscreen policy script', a => { a['offscreen.html'] = '<script src="offscreen-helper.js"></script>'; }],
    ['duplicate offscreen policy script', a => { a['offscreen.html'] += '<script src="test-run-policy.js"></script>'; }],
    ['async offscreen policy', a => { a['offscreen.html'] = a['offscreen.html'].replace('src="test-run-policy.js"', 'async src="test-run-policy.js"'); }],
    ['deferred offscreen helper', a => { a['offscreen.html'] = a['offscreen.html'].replace('src="offscreen-helper.js"', 'defer src="offscreen-helper.js"'); }],
    ['module offscreen policy', a => { a['offscreen.html'] = a['offscreen.html'].replace('src="test-run-policy.js"', 'type="module" src="test-run-policy.js"'); }],
    ['commented script only', a => { a['offscreen.html'] = '<!-- <script src="test-run-policy.js"></script> --><script src="offscreen-helper.js"></script>'; }],
    ['missing policy close swallows helper opening', a => { a['offscreen.html'] = '<script src="test-run-policy.js"><script src="offscreen-helper.js"></script>'; }],
    ['required scripts without any closing tag', a => { a['offscreen.html'] = '<script src="test-run-policy.js"><script src="offscreen-helper.js">'; }],
    ['missing helper close', a => { a['offscreen.html'] = '<script src="test-run-policy.js"></script><script src="offscreen-helper.js">'; }],
    ['fake policy dependency inside inline raw text', a => { a['offscreen.html'] = '<script>const example = \'<script src="test-run-policy.js">\';</script><script src="offscreen-helper.js"></script>'; }],
    ['fake required pair inside inline raw text', a => { a['offscreen.html'] = '<script>const example = \'<script src="test-run-policy.js"><script src="offscreen-helper.js">\';</script>'; }],
    ['end tag name prefix does not close script', a => { a['offscreen.html'] = '<script src="test-run-policy.js"></script-example><script src="offscreen-helper.js"></script>'; }],
    ['duplicate policy body', a => { a['sw-bundle.js'] += '\n' + policySource; }],
    ['duplicate shadow declaration', a => { a['sw-bundle.js'] += '\nvar TestRunPolicy = {};'; }],
    ['commented declaration', a => { a['sw-bundle.js'] = '/*\n' + policySource + '\n*/'; }],
    ['quoted declaration', a => { a['sw-bundle.js'] = JSON.stringify(policySource); }]
];
// Exercise each required dependency, not only policy tags. These cases also run
// through BOTH complete builders below and must produce zero writes/deploys.
for (const file of ['test-run-policy.js', 'offscreen-helper.js']) {
    for (const attributes of [
        'type=module', 'type="module"', "type='module'", 'TYPE = "MoDuLe"', 'type = module',
        'type=" module "', 'async', 'ASYNC=false', "async='false'", 'defer',
        'defer="false"', 'nomodule', 'NOMODULE=false', "nomodule='false'",
        'type=application/json', "type='text/plain'", 'TYPE="application/ld+json"',
        'type="text/javascript; charset=utf-8"', 'language=vbscript',
        'type="text/javascript" TYPE=module', 'type="unterminated'
    ]) {
        faults.push([file + ' rejects ' + attributes, a => {
            a['offscreen.html'] = a['offscreen.html'].replace('src="' + file + '"', attributes + ' src="' + file + '"');
        }]);
    }
}
faults.push(['src inside quoted unrelated value is not a dependency', a => {
    a['offscreen.html'] = '<script data-note=\'src="test-run-policy.js"\'></script><script src="offscreen-helper.js"></script>';
}]);
for (const bundle of ['app.js', 'sw-bundle.js']) {
    const wrappers = [
        ['multiline template', source => 'const stored = `\n' + source + '\n`;'],
        ['nested interpolated template', source => 'const stored = `outer ${`\n' + source + '\n`} end`;'],
        ['interpolation before template text', source => 'const stored = `${{ nested: `inner ${1}` }.nested}\n' + source + '\n`;'],
        ['declaration in interpolation-local function', source => 'const stored = `${(() => {\n' + source + '\nreturn "local"; })()}`;'],
        ['double-quoted source', source => 'const stored = ' + JSON.stringify(source) + ';'],
        ['single-quoted source', source => "const stored = '" + source.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n') + "';"],
        ['block-commented source', source => '/*\n' + source + '\n*/'],
        ['line-commented source', source => source.split('\n').map(line => '// ' + line).join('\n')],
        ['unterminated template prefix', source => 'const stored = `\n' + source],
        ['canonical bytes after ambiguous prefix', source => '/* open\n' + source],
        ['non-newline fragment boundary', source => source + 'void 0;']
    ];
    for (const [label, wrap] of wrappers) {
        faults.push([bundle + ' ' + label, a => { a[bundle] = wrap(policySource); }]);
    }
}
const positiveVariants = [
    ['complete script pair with mixed-case whitespace end tags', a => { a['offscreen.html'] = '<SCRIPT src="test-run-policy.js"></ScRiPt \t\r\n><script src="offscreen-helper.js"></SCRIPT\f>'; }],
    ['inline raw text and comments do not add dependencies', a => { a['offscreen.html'] = '<!-- <script src="test-run-policy.js"></script> --><script>const example = \'<script src="test-run-policy.js"><script src="offscreen-helper.js">\';</script>' + a['offscreen.html']; }],
    ['classic unquoted src', a => { a['offscreen.html'] = '<script src=test-run-policy.js></script><script src=offscreen-helper.js></script>'; }],
    ['classic single-quoted src', a => { a['offscreen.html'] = "<script src='test-run-policy.js'></script><script src='offscreen-helper.js'></script>"; }],
    ['empty boolean type', a => { a['offscreen.html'] = '<script type src="test-run-policy.js"></script><script TYPE src="offscreen-helper.js"></script>'; }],
    ['absent type with unrelated attribute text', a => { a['offscreen.html'] = '<script data-note=\'type=module async defer nomodule > src="fake.js"\' src="test-run-policy.js"></script><script data-note="type=module async" src="offscreen-helper.js"></script>'; }],
    ['benign string/template suffixes', a => {
        for (const name of ['app.js', 'sw-bundle.js']) a[name] += '\nconst stored = `outer ${`inner ${1}`} text`;\nconst quoted = "ordinary";\n// harmless suffix\n';
    }]
];
for (const type of ['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'TEXT/JAVASCRIPT', ' text/javascript ']) {
    positiveVariants.push(['allowed classic MIME ' + JSON.stringify(type), a => {
        a['offscreen.html'] = '<script type="' + type + '" src="test-run-policy.js"></script><script type=\'' + type + '\' src="offscreen-helper.js"></script>';
    }]);
}
positiveVariants.push(['unquoted classic MIME', a => { a['offscreen.html'] = '<script type=text/javascript src=test-run-policy.js></script><script TYPE=application/javascript src=offscreen-helper.js></script>'; }]);
check(guard.checkTestPolicyArtifacts(artifacts(), policySource).length === 0, 'valid canonical artifacts');
for (const [label, variant] of positiveVariants) {
    const a = artifacts(); variant(a);
    check(guard.checkTestPolicyArtifacts(a, policySource).length === 0, label);
}
for (const [label, fault] of faults) {
    const a = artifacts(); fault(a);
    check(guard.checkTestPolicyArtifacts(a, policySource).length > 0, label);
}
for (const missing of [null, '', 'TestRunPolicy.registry.bind(id, key);', 'const stored = `\n' + policySource + '\n`;', '/*\n' + policySource + '\n*/']) {
    check(guard.checkTestPolicyArtifacts(artifacts(), missing).some(s => s.includes('canonical policy declaration missing')), 'missing/invalid canonical source');
}

// Execute BOTH full real builders, not a reimplementation of their guard flow.
// Fault injection is immediately before the real guard. Invalid cases must never
// reach rm/mkdir/write/copy, workspace writes, or either icon/root deployment.
// Positive controls prove the spies are reachable and record successful outputs.
function runNode(fault, options = {}) {
    const mutations = [], written = {};
    const fakeFs = Object.assign({}, fs);
    for (const name of ['rmSync', 'mkdirSync', 'writeFileSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'appendFileSync']) {
        fakeFs[name] = (...args) => {
            mutations.push(name);
            if (name === 'writeFileSync') written[path.relative(path.join(ROOT, 'dist/extension'), args[0]).split(path.sep).join('/')] = args[1];
        };
    }
    const needle = '    const policyArtifactFailures = checkTestPolicyArtifacts(outputFiles, testRunPolicySource);';
    assert.equal(nodeSource.split(needle).length, 2);
    let code = nodeSource.replace(needle, '    faultArtifacts(outputFiles);\n' + needle);
    if (options.staleList) {
        const entry = "    'js/core/075-test-run-policy.js',";
        assert.equal(code.split(entry).length, 2);
        code = code.replace(entry, '');
    }
    const context = {
        require(name) { if (name === 'fs') return fakeFs; if (name === 'path') return path; throw new Error('Unexpected build dependency ' + name); },
        __dirname: path.join(ROOT, 'build'), Buffer, console: quiet, process: { argv: options.updateRatchet ? ['--update-ratchet'] : [] },
        faultArtifacts: fault || (() => {})
    };
    let error;
    try { vm.runInNewContext(code, context, { timeout: 30000, filename: 'build/build.js' }); }
    catch (e) { error = e; }
    return { mutations, written, error };
}
async function runBrowser(fault, options = {}) {
    const mutations = [], written = {};
    const context = vm.createContext({
        console: quiet, btoa: s => Buffer.from(s, 'binary').toString('base64'),
        faultArtifacts: fault || (() => {}),
        async executeTool(name, args) {
            assert.equal(name, 'workspace');
            if (args.action === 'hydrate') return { success: true };
            if (args.action === 'write' || args.action === 'deploy') {
                mutations.push(args.action + ':' + args.path);
                if (args.action === 'write') written[args.path.replace(/^dist\/extension\//, '')] = args.content;
                return { success: true, files_written: 1 };
            }
            if (args.action === 'read') {
                try { return { success: true, content: read(args.path).split('\n').map((line, i) => (i + 1) + '\t' + line).join('\n') }; }
                catch (_) { return { success: false }; }
            }
            if (args.action === 'ls') {
                try {
                    return { success: true, entries: fs.readdirSync(path.join(ROOT, args.path), { withFileTypes: true }).map(e => e.name + (e.isDirectory() ? '/' : '')) };
                } catch (_) { return { success: false }; }
            }
            throw new Error('Unexpected workspace action ' + args.action);
        }
    });
    const needle = '    var policyArtifactFailures = checkTestPolicyArtifacts(policyArtifacts, testRunPolicySource);';
    assert.equal(browserSource.split(needle).length, 2);
    let code = browserSource.replace(needle, '    faultArtifacts(policyArtifacts);\n' + needle);
    if (options.staleList) {
        const entry = "        'src/js/core/075-test-run-policy.js',";
        assert.equal(code.split(entry).length, 2);
        code = code.replace(entry, '');
    }
    vm.runInContext(code, context, { timeout: 30000 });
    const result = await context.extension_build({ workspace: 'fixture/AppAgent::main' });
    return { mutations, written, result };
}

async function ingressTests() {
    const background = read('src/platform/extension/background.js');
    const workerCode = between(background, 'function swTestPolicyStartupError()', '// Expose to the imported SW bundle.');
    const calls = [];
    const worker = vm.createContext({
        crypto: { randomUUID() { calls.push('uuid'); return 'fixture'; } },
        waitForOffscreenReady() { calls.push('ready'); return Promise.resolve(true); },
        chrome: { runtime: { sendMessage(message) { calls.push(message); return Promise.resolve({ ok: true, result: 7 }); } } }
    });
    vm.runInContext(workerCode, worker);
    for (const value of [undefined, null, {}, { registry: {} }]) {
        if (value === undefined) delete worker.TestRunPolicy; else worker.TestRunPolicy = value;
        for (const type of ['helper-js-eval', 'helper-skill-sandbox']) {
            await assert.rejects(worker.callOffscreenHelper(type, {}), /Inconsistent extension installation: SW TestRunPolicy/);
            check(calls.length === 0, 'SW must reject before invocation allocation, readiness or transport');
        }
    }
    vm.runInContext(policySource, worker);
    assert.equal(await worker.callOffscreenHelper('helper-js-eval', { testRunPolicy: { forged: true } }), 7);
    const sent = calls.find(c => c && c.type === 'helper-js-eval');
    check(sent && !sent.payload.testRunPolicy && sent.payload.sandboxRequestId, 'healthy ordinary eval retains registered unrestricted path and strips forged policy');
    check(worker.TestRunPolicy.registry.relay(sent.payload.sandboxRequestId, 'workspace', {}).ok === false, 'completed invocation unbound');

    const offscreen = read('src/platform/extension/offscreen-helper.js');
    const offCode = between(offscreen, '    function offscreenTestPolicyStartupError()', '})();');
    let frames = 0;
    const off = vm.createContext({ runSandboxWithCode() { frames++; return Promise.resolve(9); } });
    vm.runInContext(offCode, off);
    for (const value of [undefined, null, {}, { registry: {}, runFrame() {} }]) {
        if (value === undefined) delete off.TestRunPolicy; else off.TestRunPolicy = value;
        for (const [fn, payload] of [[off.runJsEvalSandbox, {}], [off.runJsEvalSandbox, { testRunPolicy: {} }], [off.runSkillSandbox, {}]]) {
            await assert.rejects(fn(payload), /Inconsistent extension installation: offscreen TestRunPolicy/);
            check(frames === 0, 'offscreen must reject before any frame allocation');
        }
    }
    vm.runInContext(policySource, off);
    assert.equal(await off.runJsEvalSandbox({ code: 'return 9;' }), 9);
    assert.equal(await off.runSkillSandbox({ toolName: 'fixture' }), 9);
    check(frames === 2, 'healthy ordinary eval and skill preserve existing path');
}

(async function main() {
    // The byte-zero prelude must initialize with only native JS built-ins, before
    // any Platform/DOM globals. This executes canonical SOURCE in an isolated test
    // context, never generated artifacts in the production build validator.
    const prelude = vm.createContext({});
    const sloppyPrelude = vm.runInContext(policySource + '\n(function() { return this; })() === globalThis;', prelude);
    check(prelude.TestRunPolicy && typeof prelude.TestRunPolicy.registry.bind === 'function', 'policy initializes before runtime/DOM globals');
    check(sloppyPrelude, 'policy IIFE strict mode does not change script directive scope');
    // Syntax-check changed runtime files without starting Chrome or the worker.
    new vm.Script(read('src/platform/extension/background.js'));
    new vm.Script(read('src/platform/extension/offscreen-helper.js'));
    const goodNode = runNode();
    assert.ifError(goodNode.error);
    check(goodNode.mutations.includes('writeFileSync'), 'Node positive control reaches writer');
    check(guard.checkTestPolicyArtifacts(goodNode.written, policySource).length === 0, 'Node emitted artifacts valid');
    const goodBrowser = await runBrowser();
    check(goodBrowser.result.success, 'browser positive control: ' + goodBrowser.result.error);
    check(goodBrowser.mutations.includes('deploy:src/platform/extension/icons') && goodBrowser.mutations.includes('deploy:dist/extension'), 'browser positive control reaches both deploy boundaries');
    check(guard.checkTestPolicyArtifacts(goodBrowser.written, policySource).length === 0, 'browser emitted artifacts valid');
    for (const [builder, output] of [['Node', goodNode.written], ['browser', goodBrowser.written]]) {
        for (const name of ['app.js', 'sw-bundle.js']) {
            check(output[name].startsWith(policySource + '\n'), builder + ' executable byte-zero prelude: ' + name);
            check(output[name].split(policySource).length === 2, builder + ' exactly one canonical policy: ' + name);
            check((output[name].match(/^var TestRunPolicy = /gm) || []).length === 1, builder + ' exactly one policy definition: ' + name);
        }
    }
    // Guard-only positives are insufficient: every accepted attribute form also
    // traverses the real build entry points and reaches the recording writers.
    for (const [label, variant] of positiveVariants) {
        const node = runNode(variant);
        assert.ifError(node.error);
        check(node.mutations.includes('writeFileSync'), 'Node accepts ' + label);
        const browser = await runBrowser(variant);
        check(browser.result.success, 'browser accepts ' + label + ': ' + browser.result.error);
        check(browser.mutations.includes('deploy:dist/extension'), 'browser deploy boundary for ' + label);
    }
    for (const [label, fault] of faults) {
        const node = runNode(fault);
        check(node.error && /Build aborted.*host policy artifacts/.test(node.error.message), 'Node surfaces artifact error: ' + label);
        assert.deepEqual(node.mutations, [], 'Node performs no mutations: ' + label);
        const browser = await runBrowser(fault);
        check(browser.result.success === false && /host policy artifacts/.test(browser.result.error), 'browser surfaces artifact error: ' + label);
        assert.deepEqual(browser.mutations, [], 'browser performs no writes/deploys: ' + label);
    }
    const staleNode = runNode(null, { staleList: true });
    check(staleNode.error && /host policy artifacts/.test(staleNode.error.message), 'real stale Node shared-file whitelist rejected');
    assert.deepEqual(staleNode.mutations, []);
    const staleBrowser = await runBrowser(null, { staleList: true });
    check(!staleBrowser.result.success && /host policy artifacts/.test(staleBrowser.result.error), 'real stale browser shared-file whitelist rejected');
    assert.deepEqual(staleBrowser.mutations, []);
    const ratchetFailure = runNode(faults[0][1], { updateRatchet: true });
    check(ratchetFailure.error && /host policy artifacts/.test(ratchetFailure.error.message), 'invalid artifacts abort even with --update-ratchet');
    assert.deepEqual(ratchetFailure.mutations, [], 'not even the ratchet baseline may be written');
    await ingressTests();
    console.log('PASS: policy artifacts, full builder mutation boundaries and ingress guards (' + assertions + ' explicit checks plus equality/rejection assertions).');
})().catch(error => { console.error(error); process.exitCode = 1; });
