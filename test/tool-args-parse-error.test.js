// #19 — "document create JSON parse failure on large content": the ONLY
// reproducible mechanism is a tool_call `arguments` string cut off by
// max_tokens (010-llm-streaming.js just concatenates deltas; finish_reason
// 'length' is not tracked). JSON.parse then throws "Unexpected end of JSON
// input" and the model only saw "Invalid tool arguments: …" — nothing told it
// the payload was TRUNCATED and that it should split the content.
describe('tool arguments parse error message (030-agent-loop.js)', function() {
    async function load() {
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(typeof m._toolArgsParseErrorMessage, 'function', '_toolArgsParseErrorMessage helper must exist');
        return m;
    }
    function parseErrOf(str) { try { JSON.parse(str); } catch (e) { return e; } return null; }
    test('truncated (max_tokens) arguments: message says cut off + char count + split advice', async function() {
        var m = await load();
        var big = '{"title":"Doc","content":"' + 'x'.repeat(5000);
        var err = parseErrOf(big);
        assert.ok(err, 'fixture must not parse');
        var msg = m._toolArgsParseErrorMessage(big, err);
        assert.ok(/Invalid tool arguments/.test(msg), msg);
        assert.ok(/cut off|truncated/i.test(msg), 'must say truncated: ' + msg);
        assert.ok(msg.indexOf(String(big.length)) > -1, 'must include the received length: ' + msg);
        assert.ok(/max_tokens/.test(msg), 'must name the likely cause: ' + msg);
        assert.ok(/split|smaller/i.test(msg), 'must advise splitting: ' + msg);
    });
    test('truncated inside an object (no unterminated string): still detected via end-of-input', async function() {
        var m = await load();
        var s = '{"a":1,"b":{"c":[1,2,3';
        var msg = m._toolArgsParseErrorMessage(s, parseErrOf(s));
        assert.ok(/cut off|truncated/i.test(msg), msg);
    });
    test('genuinely malformed JSON (not truncated): original parser message kept, no truncation claim', async function() {
        var m = await load();
        var s = '{"a":1,,"b":2}';
        var err = parseErrOf(s);
        var msg = m._toolArgsParseErrorMessage(s, err);
        assert.ok(msg.indexOf(err.message) > -1, 'keeps parser message: ' + msg);
        assert.ok(!/cut off|truncated/i.test(msg), 'must NOT claim truncation: ' + msg);
    });
    test('non-JSON-error (e.g. "arguments must be a JSON object"): passthrough', async function() {
        var m = await load();
        var msg = m._toolArgsParseErrorMessage('[1,2]', new Error('arguments must be a JSON object'));
        assert.strictEqual(msg, 'Invalid tool arguments: arguments must be a JSON object');
    });
});
