// Chrome built-in i18n (chrome.i18n) for the manifest only.
//  - manifest: default_locale is set and name/description/action.default_title
//    use __MSG_*__ placeholders.
//  - _locales: every __MSG_x__ key used in the manifest exists with a non-empty
//    message (and a translator description) in every
//    src/platform/extension/_locales/<chromeCode>/messages.json; folder names are
//    Chrome-supported locale codes; one folder per app language (fr-CA is
//    covered by fr via Chrome's region fallback, nb ships as Chrome's "no").
//  - builds: both build/build.js and skills/extension-dev/build.js copy
//    _locales/** into dist/extension/ and abort when the default locale's
//    messages.json is missing (Chrome refuses to load the extension then).
// Run: run_tests { pattern: 'chrome-i18n-manifest' }
var WS = args.workspace;
var LOCALES_DIR = 'src/platform/extension/_locales';
// https://developer.chrome.com/docs/extensions/reference/api/i18n#locales
var CHROME_LOCALES = ['ar', 'am', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'en_AU', 'en_GB', 'en_US', 'es', 'es_419', 'et', 'fa', 'fi', 'fil', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms', 'nl', 'no', 'pl', 'pt_BR', 'pt_PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh_CN', 'zh_TW'];
// App language code -> Chrome _locales folder (null = covered by fallback).
var APP_TO_CHROME = { 'fr-CA': null, 'nb': 'no' };
function chromeCodeFor(appCode) {
    if (Object.prototype.hasOwnProperty.call(APP_TO_CHROME, appCode)) return APP_TO_CHROME[appCode];
    return appCode.replace('-', '_');
}

async function manifest() { return JSON.parse(await loadFile('src/platform/extension/manifest.json', WS)); }
function msgKeys(m) {
    var keys = [];
    JSON.stringify(m).replace(/__MSG_([A-Za-z0-9_@]+)__/g, function(_, k) { if (keys.indexOf(k) < 0) keys.push(k); return _; });
    return keys;
}
async function localeFolders() {
    var r = await executeTool('workspace', { action: 'ls', path: LOCALES_DIR, workspace: WS });
    assert.ok(r && r.success, 'ls ' + LOCALES_DIR + ' failed: ' + JSON.stringify(r && r.error));
    return r.entries.map(function(e) { return String(e).split(' ')[0].replace(/\/$/, ''); }).sort();
}

describe('chrome i18n: manifest', function() {
    test('default_locale is "en" and user-visible strings are __MSG_ placeholders', async function() {
        var m = await manifest();
        assert.strictEqual(m.default_locale, 'en');
        assert.strictEqual(m.name, '__MSG_extName__');
        assert.strictEqual(m.description, '__MSG_extDescription__');
        assert.strictEqual(m.action.default_title, '__MSG_actionTitle__');
        assert.deepStrictEqual(msgKeys(m).sort(), ['actionTitle', 'extDescription', 'extName']);
    }, { tags: ['unit'] });
});

describe('chrome i18n: _locales/<code>/messages.json', function() {
    test('folders = en + one Chrome-supported code per app language', async function() {
        var mod = await loadModules(['src/js/core/025-i18n.js'], { workspace: WS, globals: {} });
        var expected = ['en'];
        mod.I18N_LANGUAGES.forEach(function(l) {
            var c = l.code === 'en' ? null : chromeCodeFor(l.code);
            if (c && expected.indexOf(c) < 0) expected.push(c);
        });
        var folders = await localeFolders();
        assert.deepStrictEqual(folders, expected.sort());
        var unsupported = folders.filter(function(f) { return CHROME_LOCALES.indexOf(f) < 0; });
        assert.deepStrictEqual(unsupported, [], 'every folder is a Chrome-supported locale code');
        assert.strictEqual(folders.length, 24);
    }, { tags: ['unit'] });

    test('every manifest __MSG_ key has a non-empty message + description in every locale', async function() {
        var keys = msgKeys(await manifest());
        assert.ok(keys.length === 3);
        var folders = await localeFolders(), problems = [];
        var en = JSON.parse(await loadFile(LOCALES_DIR + '/en/messages.json', WS));
        for (var i = 0; i < folders.length; i++) {
            var code = folders[i], cat;
            try { cat = JSON.parse(await loadFile(LOCALES_DIR + '/' + code + '/messages.json', WS)); }
            catch (e) { problems.push(code + ': messages.json missing or invalid JSON (' + e.message + ')'); continue; }
            keys.forEach(function(k) {
                var e = cat[k];
                if (!e || typeof e.message !== 'string' || !e.message.trim()) problems.push(code + ':' + k + ' message missing/empty');
                else if (typeof e.description !== 'string' || !e.description.trim()) problems.push(code + ':' + k + ' description missing');
            });
            if (cat.extName && cat.extName.message.length > 75) problems.push(code + ': extName > 75 chars');
            if (cat.extDescription && cat.extDescription.message.length > 132) problems.push(code + ': extDescription > 132 chars');
            ['extName', 'actionTitle'].forEach(function(k) {
                if (cat[k] && cat[k].message.indexOf('AppAgent') < 0) problems.push(code + ':' + k + ' must keep "AppAgent" untranslated');
            });
            // Real translation: only the Norwegian name may equal English ("for" is Norwegian too).
            if (code !== 'en') keys.forEach(function(k) {
                if (cat[k] && cat[k].message === en[k].message && !(code === 'no' && k === 'extName')) problems.push(code + ':' + k + ' is untranslated English');
            });
        }
        assert.deepStrictEqual(problems, []);
    }, { tags: ['unit'], timeout: 20000 });
});

// The locale staging is an inline block inside each (large, side-effecting)
// build function, so it cannot be loaded as a module. Instead the REAL block
// is sliced out of the build source between its section comment and the next
// statement, and executed with in-memory stand-ins for its free variables
// (ws/readFile/_mapLimit resp. fs/path) — asserting what it does, not how it
// is spelled. Only the slice markers and the "staged before the write step"
// ordering remain source-position checks (the full build is not runnable here).
var AsyncFn = Object.getPrototypeOf(async function() {}).constructor;
function sliceBlock(src, startMarker, endMarker) {
    var a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
    assert.ok(a > 0 && b > a, 'locale block markers found: ' + startMarker + ' .. ' + endMarker);
    return src.slice(a, b);
}
var FAKE_LOCALES = { en: '{"extName":{"message":"AppAgent"}}', fr: '{"extName":{"message":"AppAgent FR"}}', pt_BR: '{"extName":{"message":"AppAgent BR"}}' };

describe('chrome i18n: builds copy _locales/** into dist/extension', function() {
    async function runBrowserBlock(locales, manifestRaw) {
        var src = await loadFile('skills/extension-dev/build.js', WS);
        var block = sliceBlock(src, '// 8a. Chrome i18n', "var testRunPolicySource = await readFile('src/js/core/075-test-run-policy.js');");
        var lsCalls = [], outputFiles = [{ path: 'dist/extension/manifest.json', content: manifestRaw }];
        var fn = new AsyncFn('ws', 'readFile', '_mapLimit', 'BUILD_READ_CONCURRENCY', 'outputFiles', 'manifestRaw', 'defaultWorkspace',
            block + '\nreturn { copied: chromeLocalesCopied };');
        var r = await fn(
            async function(action, a) { lsCalls.push([action, a.path]); return { success: true, entries: Object.keys(locales).map(function(c) { return c + '/ (1 files)'; }).concat(['.DS_Store', 'README.md']) }; },
            async function(p) { var mm = /^src\/platform\/extension\/_locales\/([^/]+)\/messages\.json$/.exec(p); return mm && locales[mm[1]] != null ? locales[mm[1]] : null; },
            async function(items, n, f) { return Promise.all(items.map(f)); },
            4, outputFiles, manifestRaw, 'example-org/AppAgent::main');
        return { r: r, outputFiles: outputFiles, lsCalls: lsCalls };
    }

    test('in-browser extension_build (skills/extension-dev/build.js) stages _locales and guards default_locale', async function() {
        var ok = await runBrowserBlock(FAKE_LOCALES, JSON.stringify({ default_locale: 'en' }));
        assert.deepStrictEqual(ok.lsCalls, [['ls', 'src/platform/extension/_locales']]);
        assert.deepStrictEqual(ok.r, { copied: 3 });
        var staged = ok.outputFiles.filter(function(f) { return f.path.indexOf('dist/extension/_locales/') === 0; });
        assert.deepStrictEqual(staged.map(function(f) { return f.path; }).sort(), ['dist/extension/_locales/en/messages.json', 'dist/extension/_locales/fr/messages.json', 'dist/extension/_locales/pt_BR/messages.json']);
        assert.strictEqual(staged.filter(function(f) { return f.path.indexOf('/fr/') > 0; })[0].content, FAKE_LOCALES.fr, 'content copied verbatim');
        var bad = await runBrowserBlock({ fr: FAKE_LOCALES.fr }, JSON.stringify({ default_locale: 'en' }));
        assert.strictEqual(bad.r.success, false);
        assert.match(bad.r.error, /Build aborted .*default_locale "en"/);
        // Staged before the policy-artifact snapshot / write step, so it is written + deployed with dist/extension.
        var src = await loadFile('skills/extension-dev/build.js', WS);
        assert.ok(src.indexOf('// 8a. Chrome i18n') < src.indexOf('var policyArtifacts = {};'));
        assert.ok(src.indexOf('// 8a. Chrome i18n') < src.indexOf('var writeResults = await _mapLimit(outputFiles'));
    }, { tags: ['unit'] });

    async function runNodeBlock(locales, manifestRaw) {
        var src = await loadFile('build/build.js', WS);
        var block = sliceBlock(src, '// Chrome i18n: src/platform/extension/_locales', "const testRunPolicySource = readSrcFile(");
        var base = 'src/platform/extension', files = {};
        Object.keys(locales).forEach(function(c) { files[base + '/_locales/' + c + '/messages.json'] = locales[c]; });
        var fsFake = {
            existsSync: function(p) { return p === base + '/_locales' || Object.prototype.hasOwnProperty.call(files, p); },
            readdirSync: function(p) { return p === base + '/_locales' ? Object.keys(locales).concat(['.DS_Store', 'fr-CA']) : []; },
            readFileSync: function(p) { if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT ' + p); return files[p]; }
        };
        var pathFake = { join: function() { return Array.prototype.slice.call(arguments).join('/'); } };
        var outputFiles = { 'manifest.json': manifestRaw }, logs = [];
        var fn = new AsyncFn('fs', 'path', 'extSrcDir', 'outputFiles', 'console', block + '\nreturn chromeLocalesCopied;');
        var copied = await fn(fsFake, pathFake, base, outputFiles, { log: function(s) { logs.push(s); } });
        return { copied: copied, outputFiles: outputFiles, logs: logs };
    }

    test('Node build (build/build.js) stages _locales and guards default_locale', async function() {
        var ok = await runNodeBlock(FAKE_LOCALES, JSON.stringify({ default_locale: 'en' }));
        assert.strictEqual(ok.copied, 3);
        assert.deepStrictEqual(Object.keys(ok.outputFiles).filter(function(k) { return k.indexOf('_locales/') === 0; }).sort(), ['_locales/en/messages.json', '_locales/fr/messages.json', '_locales/pt_BR/messages.json']);
        assert.strictEqual(ok.outputFiles['_locales/pt_BR/messages.json'], FAKE_LOCALES.pt_BR);
        await assert.rejects(runNodeBlock({ fr: FAKE_LOCALES.fr }, JSON.stringify({ default_locale: 'en' })), /Build aborted .*default_locale "en"/);
        var none = await runNodeBlock({ fr: FAKE_LOCALES.fr }, JSON.stringify({ name: 'x' }));
        assert.strictEqual(none.copied, 1, 'no default_locale -> no guard');
        var src = await loadFile('build/build.js', WS);
        assert.ok(src.indexOf("outputFiles['_locales/'") < src.indexOf('for (const [file, content] of Object.entries(outputFiles))'));
    }, { tags: ['unit'] });

    test('the builds\' locale-folder filter accepts every shipped folder and rejects junk', async function() {
        var re = /^[a-z]{2,3}(_[A-Z0-9]{2,3})?$/;
        var folders = await localeFolders();
        assert.deepStrictEqual(folders.filter(function(f) { return !re.test(f); }), []);
        assert.deepStrictEqual(['es_419', 'fil', 'zh_TW'].map(function(c) { return re.test(c); }), [true, true, true]);
        assert.deepStrictEqual(['.DS_Store', 'fr-CA', '../x', 'README.md'].map(function(c) { return re.test(c); }), [false, false, false, false]);
    }, { tags: ['unit'] });
});
