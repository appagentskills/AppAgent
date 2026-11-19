// Every chrome.scripting.executeScript( call in background.js must be bounded
// (snInjectBounded / snWithTimeout): an unbounded one into a tab stuck on a
// login/SSO page or a dialog never settles and used to hang its caller until a
// browser restart.

var EX = await runFile('test/extract.js', { i18n: false });

describe('background.js executeScript calls are bounded', function() {
    test('no bare chrome.scripting.executeScript( call', async function() {
        var src = await loadFile('src/platform/extension/background.js');
        var mask = EX.codeMask(src);
        var needle = 'chrome.scripting.executeScript(';
        var bad = [];
        var i = 0, n = 0;
        while ((i = mask.indexOf(needle, i)) !== -1) {
            n++;
            var before = mask.slice(Math.max(0, i - 40), i);
            if (!/(snInjectBounded|snWithTimeout)\(\s*$/.test(before)) bad.push(src.slice(0, i).split('\n').length);
            i += needle.length;
        }
        assert.ok(n >= 5, 'scan found the call sites (' + n + ')');
        assert.deepStrictEqual(bad, [], 'unbounded executeScript at background.js lines ' + bad.join(', '));
    }, { tags: ['unit'], timeout: 5000 });

    test('snInjectBounded keeps value, rethrows errors, rejects on timeout', async function() {
        var src = await loadFile('src/platform/extension/background.js');
        var f = new Function('self', EX.extractFunctions(src, ['snTimeoutMs', 'snWithTimeout', 'snInjectBounded']) + '\nreturn snInjectBounded;')({});
        assert.strictEqual(await f(Promise.resolve(7), 50), 7);
        var e1 = await f(Promise.reject(new Error('boom')), 50).then(function() { return null; }, function(e) { return e.message; });
        assert.strictEqual(e1, 'boom');
        var t0 = Date.now();
        var e2 = await f(new Promise(function() {}), 30).then(function() { return null; }, function(e) { return e.message; });
        assert.strictEqual(e2, 'timeout');
        assert.ok(Date.now() - t0 < 1000);
    }, { tags: ['unit'], timeout: 5000 });
});
