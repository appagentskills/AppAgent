// chat_history (tools/165-chat-history.js): safe, read-only past-chat reader.
// Real source via loadModules; only IndexedDB (openDatabase) is faked.

function fakeIdb(data, log) {
    function req(result) {
        var rq = { result: undefined, onsuccess: null, onerror: null };
        Promise.resolve().then(function() { rq.result = result; if (rq.onsuccess) rq.onsuccess(); });
        return rq;
    }
    function makeStore(name) {
        var rows = data[name] || {};
        return {
            get: function(key) { log.ops.push(name + ':get'); return req(rows[key]); },
            openCursor: function() {
                log.ops.push(name + ':cursor');
                var keys = Object.keys(rows), i = 0;
                var rq = { result: undefined, onsuccess: null, onerror: null };
                function step() {
                    Promise.resolve().then(function() {
                        if (i >= keys.length) { rq.result = null; }
                        else {
                            var k = keys[i];
                            rq.result = { primaryKey: k, value: JSON.parse(JSON.stringify(rows[k])), continue: function() { i++; step(); } };
                        }
                        if (rq.onsuccess) rq.onsuccess();
                    });
                }
                step();
                return rq;
            },
            put: function() { throw new Error('WRITE ATTEMPTED'); },
            delete: function() { throw new Error('WRITE ATTEMPTED'); },
            clear: function() { throw new Error('WRITE ATTEMPTED'); }
        };
    }
    return {
        objectStoreNames: ['chats', 'chat_payloads', 'settings', 'workspaces'],
        transaction: function(names, mode) {
            log.tx.push({ names: names.slice(), mode: mode });
            return { objectStore: function(n) {
                if (names.indexOf(n) === -1) throw new Error('store not in tx scope');
                return makeStore(n);
            } };
        }
    };
}

function sampleData() {
    var msgs = [];
    for (var i = 0; i < 120; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'message ' + i });
    msgs[5] = { role: 'user', content: 'please deploy the widget', file_id: 'file_img', _b64Evicted: true };
    return {
        chats: {
            c_old: { id: 'c_old', title: 'Old chat', createdAt: 1000, updatedAt: 2000, messages: [{ role: 'user', content: 'hello banana' }] },
            c_new: { id: 'c_new', title: 'New chat', createdAt: 5000, updatedAt: 9000, messages: msgs,
                cachedToolResults: { cache_1: { _fcEvicted: true, toolName: 'x' } } },
            c_sub: { id: 'c_sub', title: 'Worker', createdAt: 3000, isSubAgent: true, parentChatId: 'c_new', messages: [{ role: 'user', content: 'Banana task' }] }
        },
        chat_payloads: {
            file_img: { id: 'file_img', base64: 'data:image/png;base64,' + 'A'.repeat(5000), at: 1 },
            cache_1: { id: 'cache_1', base64: '{"rows":["secret kiwi value"]}', at: 1 }
        },
        settings: { apiKey: { id: 'apiKey', value: 'sk-SHOULD-NEVER-BE-READ' } }
    };
}

async function loadCH(data) {
    var log = { tx: [], ops: [] };
    var dbh = fakeIdb(data || sampleData(), log);
    var m = await loadModules(['src/js/tools/165-chat-history.js'], {
        globals: { openDatabase: function() { return Promise.resolve(dbh); } }
    });
    return { m: m, log: log };
}

function assertSafe(log) {
    log.tx.forEach(function(t) {
        assert.strictEqual(t.mode, 'readonly', 'every transaction must be readonly');
        t.names.forEach(function(n) { assert.ok(n === 'chats' || n === 'chat_payloads', 'unexpected store opened: ' + n); });
    });
}

describe('chat_history safety', function() {
    test('allowlist is exactly chats + chat_payloads and mode is readonly', async function() {
        var h = await loadCH();
        assert.deepStrictEqual(h.m.CH_ALLOWED_STORES, ['chats', 'chat_payloads']);
        assert.strictEqual(h.m.CH_TX_MODE, 'readonly');
        var threw = false;
        try { await h.m._chOpenStore('settings'); } catch (e) { threw = /may only read/.test(e.message); }
        assert.ok(threw, 'opening a non-allowlisted store must throw');
        assert.strictEqual(h.log.tx.length, 0, 'no transaction opened for a refused store');
    }, { tags: ['unit'] });

    test('list/search/get only open allowlisted stores readonly', async function() {
        var h = await loadCH();
        await h.m.executeChatHistory({ action: 'list' });
        await h.m.executeChatHistory({ action: 'search', pattern: 'sk-SHOULD' });
        await h.m.executeChatHistory({ action: 'search', pattern: 'kiwi', chat_id: 'c_new' });
        await h.m.executeChatHistory({ action: 'get', chat_id: 'c_new', from: 0, to: 10 });
        assert.ok(h.log.tx.length >= 4);
        assertSafe(h.log);
        var s = await h.m.executeChatHistory({ action: 'search', pattern: 'sk-SHOULD' });
        assert.strictEqual(s.matches.length, 0, 'settings store content must be unreachable');
    }, { tags: ['unit'] });

    test('default permission is ask and the key shows in Settings', async function() {
        var p = await loadModules(['src/js/core/070-permissions.js'], { lenient: true });
        assert.ok(p.GLOBAL_WRITE_KEYS.indexOf('chat_history') !== -1);
        assert.ok(p.GLOBAL_ASK_DEFAULT_KEYS.indexOf('chat_history') !== -1);
        assert.strictEqual(p.getGlobalDefaultPermission('chat_history'), 'ask');
    }, { tags: ['unit'] });

    test('registered: TOOLS entry, headless, profiles, dispatch arm, worker build lists', async function() {
        var tools = await loadFile('src/js/core/080-tools.js');
        assert.ok(/name: 'chat_history'/.test(tools));
        assert.ok(/\n    chat_history: true,/.test(tools));
        var prof = await loadModules(['src/js/core/078-tool-profiles.js'], { lenient: true });
        assert.ok(prof.TOOL_PROFILES.orchestrator.tools.indexOf('chat_history') !== -1);
        assert.ok(prof.TOOL_PROFILES['extension-dev'].tools.indexOf('chat_history') !== -1);
        var ex = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/name === 'chat_history'[\s\S]{0,600}executeChatHistory\(args\)/.test(ex));
        var b1 = await loadFile('build/build.js'), b2 = await loadFile('skills/extension-dev/build.js');
        assert.ok(b1.indexOf("'js/tools/165-chat-history.js'") > b1.indexOf("'js/tools/160-run-tests.js'"));
        assert.ok(b1.indexOf("'js/tools/165-chat-history.js'") < b1.indexOf("'js/tools/170-local-folders.js'"));
        assert.ok(b2.indexOf("'src/js/tools/165-chat-history.js'") > b2.indexOf("'src/js/tools/160-run-tests.js'"));
        assert.ok(b2.indexOf("'src/js/tools/165-chat-history.js'") < b2.indexOf("'src/js/tools/170-local-folders.js'"));
    }, { tags: ['unit'] });
});

describe('chat_history behaviour', function() {
    test('list: newest first, since/until filters, limit cap', async function() {
        var h = await loadCH();
        var r = await h.m.executeChatHistory({ action: 'list' });
        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(r.chats.map(function(c) { return c.id; }), ['c_new', 'c_sub', 'c_old']);
        assert.strictEqual(r.chats[0].message_count, 120);
        assert.strictEqual(r.chats[1].is_sub_agent, true);
        var f = await h.m.executeChatHistory({ action: 'list', since: 2500, until: 8000 });
        assert.deepStrictEqual(f.chats.map(function(c) { return c.id; }), ['c_sub']);
        var l = await h.m.executeChatHistory({ action: 'list', limit: 1 });
        assert.strictEqual(l.chats.length, 1); assert.strictEqual(l.total, 3);
        assert.strictEqual(h.m._chLimit(99999, 20, 200), 200);
        var bad = await h.m.executeChatHistory({ action: 'list', since: 'not a date' });
        assert.strictEqual(bad.success, false);
    }, { tags: ['unit'] });

    test('search: case-insensitive default, payload text scanned for one chat, limit cap', async function() {
        var h = await loadCH();
        var r = await h.m.executeChatHistory({ action: 'search', pattern: 'banana' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.matches.length, 2);
        assert.ok(r.matches.every(function(x) { return x.chat_id && typeof x.path === 'string' && /banana/i.test(x.excerpt); }));
        var p = await h.m.executeChatHistory({ action: 'search', pattern: 'kiwi', chat_id: 'c_new' });
        assert.strictEqual(p.matches.length, 1);
        assert.strictEqual(p.matches[0].path, "cachedToolResults['cache_1'].fullContent");
        var many = await h.m.executeChatHistory({ action: 'search', pattern: 'message', limit: 1000 });
        assert.ok(many.matches.length <= 100);
        assert.strictEqual(many.truncated, true);
    }, { tags: ['unit'] });

    test('search: invalid regex returns a clear error', async function() {
        var h = await loadCH();
        var r = await h.m.executeChatHistory({ action: 'search', pattern: '([unclosed' });
        assert.strictEqual(r.success, false);
        assert.ok(/^Invalid regex/.test(r.error));
        var r2 = await h.m.executeChatHistory({ action: 'search' });
        assert.strictEqual(r2.success, false);
    }, { tags: ['unit'] });

    test('get: range capped at 50, payload stubs resolved, binary never inlined, path drill', async function() {
        var h = await loadCH();
        var r = await h.m.executeChatHistory({ action: 'get', chat_id: 'c_new', from: 0, to: 500 });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.messages.length, 50);
        assert.strictEqual(r.range_capped, true);
        assert.strictEqual(r.has_more, true);
        var stub = r.messages[5]._payload;
        assert.strictEqual(stub.id, 'file_img');
        assert.strictEqual(stub.present, true);
        assert.ok(stub.text === undefined, 'binary payload must not be inlined');
        var tail = await h.m.executeChatHistory({ action: 'get', chat_id: 'c_new', from: -3 });
        assert.strictEqual(tail.from, 117); assert.strictEqual(tail.messages.length, 3);
        var p = await h.m.executeChatHistory({ action: 'get', chat_id: 'c_new', path: 'cachedToolResults' });
        assert.ok(/kiwi/.test(p.value.cache_1._payload.text));
        var d = await h.m.executeChatHistory({ action: 'get', chat_id: 'c_old', path: 'messages[0].content' });
        assert.strictEqual(d.value, 'hello banana');
        var missing = await h.m.executeChatHistory({ action: 'get', chat_id: 'nope' });
        assert.strictEqual(missing.success, false);
        var noId = await h.m.executeChatHistory({ action: 'get' });
        assert.strictEqual(noId.success, false);
        var unk = await h.m.executeChatHistory({ action: 'delete' });
        assert.strictEqual(unk.success, false);
        assertSafe(h.log);
    }, { tags: ['unit'] });
});

function bigData(nChats, charsPerChat) {
    var chats = {};
    for (var i = 0; i < nChats; i++) {
        chats['b' + i] = { id: 'b' + i, title: 'Big ' + i, createdAt: i, messages: [{ role: 'user', content: 'x, '.repeat(Math.ceil(charsPerChat / 3)) }] };
    }
    return { chats: chats, chat_payloads: {} };
}

describe('chat_history hardening', function() {
    test('fix1: search stops at the global char budget with truncated_reason', async function() {
        var h = await loadCH(bigData(6, 3000));
        h.m.CH_SEARCH_BUDGET.chars = 7000; // ~2.3 chats worth
        var r = await h.m.executeChatHistory({ action: 'search', pattern: 'nomatch' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.truncated, true);
        assert.strictEqual(r.truncated_reason, 'char_budget');
        assert.ok(r.chars_scanned <= 7000, 'scanned ' + r.chars_scanned);
        assert.ok(r.chats_scanned < 6, 'stopped before scanning every chat');
        // default budget is 8MB / 2s
        var d = await loadCH();
        assert.strictEqual(d.m.CH_SEARCH_BUDGET.chars, 8 * 1048576);
        assert.strictEqual(d.m.CH_SEARCH_BUDGET.ms, 2000);
        var ok = await d.m.executeChatHistory({ action: 'search', pattern: 'banana' });
        assert.strictEqual(ok.truncated, false);
        assert.ok(ok.truncated_reason === undefined);
    }, { tags: ['unit'] });

    test('fix1: search stops at the wall-clock budget with truncated_reason', async function() {
        var h = await loadCH(bigData(6, 300));
        var t = 0;
        h.m.CH_SEARCH_BUDGET.now = function() { t += 1000; return t; }; // 1s per check
        var r = await h.m.executeChatHistory({ action: 'search', pattern: 'nomatch' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.truncated, true);
        assert.strictEqual(r.truncated_reason, 'time_budget');
        assert.ok(r.chats_scanned < 6);
        var m = await loadCH();
        var lim = await m.m.executeChatHistory({ action: 'search', pattern: 'message', limit: 3 });
        assert.strictEqual(lim.truncated_reason, 'match_limit');
    }, { tags: ['unit'] });

    test('fix2: list output is passed through _chSafeSerialize (titles capped)', async function() {
        var data = sampleData();
        data.chats.c_old.title = 'Long title, '.repeat(1000);
        var h = await loadCH(data);
        var r = await h.m.executeChatHistory({ action: 'list' });
        var t = r.chats.filter(function(c) { return c.id === 'c_old'; })[0].title;
        assert.ok(t.length < 4200, 'title capped, got ' + t.length);
        assert.ok(/chars\]$/.test(t));
    }, { tags: ['unit'] });

    test('fix3: binary strings omitted in output and skipped by search', async function() {
        var h = await loadCH();
        var blob = 'data:image/png;base64,' + 'QUJD'.repeat(500);
        assert.strictEqual(h.m._chSafeSerialize({ a: blob }).a, '[binary ' + blob.length + ' chars omitted]');
        var raw = 'QUJD'.repeat(200);
        assert.strictEqual(h.m._chSafeSerialize(raw), '[binary 800 chars omitted]');
        assert.strictEqual(h.m._chSafeSerialize('plain text'), 'plain text');
        var data = sampleData();
        data.chats.c_old.messages.push({ role: 'user', image: 'data:image/png;base64,' + 'ZEBRA'.repeat(100) });
        var h2 = await loadCH(data);
        var s = await h2.m.executeChatHistory({ action: 'search', pattern: 'ZEBRA', flags: '' });
        assert.strictEqual(s.matches.length, 0, 'binary string must not be scanned');
        var g = await h2.m.executeChatHistory({ action: 'get', chat_id: 'c_old' });
        assert.ok(/^\[binary \d+ chars omitted\]$/.test(g.messages[1].image));
    }, { tags: ['unit'] });

    test('fix4: 64KB-capped output still carries success:true', async function() {
        var h = await loadCH();
        var big = [];
        for (var i = 0; i < 40; i++) big.push('word, '.repeat(700));
        var r = h.m._chSafeSerialize({ success: true, items: big });
        assert.strictEqual(r._truncated, true);
        assert.strictEqual(r.success, true);
        var data = sampleData();
        data.chats.c_new.messages = data.chats.c_new.messages.map(function(m, i) { return { role: m.role, content: 'line ' + i + ', ' + 'abc, '.repeat(1000) }; });
        var h2 = await loadCH(data);
        var g = await h2.m.executeChatHistory({ action: 'get', chat_id: 'c_new', from: 0, to: 50 });
        assert.strictEqual(g._truncated, true);
        assert.strictEqual(g.success, true);
    }, { tags: ['unit'] });

    test('fix5: likely credentials are redacted in every output string', async function() {
        var h = await loadCH();
        var secrets = [
            'sk-abcdefgh12345678', 'ghp_' + 'a'.repeat(36), 'gho_' + 'B'.repeat(24),
            'Bearer eyJhbGciOi.xyz', 'X-UserToken:abc123def', 'JSESSIONID=ABCDEF0123', 'glide_session_store=99XYZ'
        ];
        secrets.forEach(function(sec) {
            var out = h.m._chSafeSerialize({ v: 'before ' + sec + '; after' }).v;
            assert.ok(out.indexOf('[redacted]') !== -1, 'not redacted: ' + sec + ' -> ' + out);
            assert.ok(/^before /.test(out) && /after$/.test(out), 'context kept: ' + out);
        });
        assert.strictEqual(h.m._chSafeSerialize('sk-short'), 'sk-short');
        var data = sampleData();
        data.chats.c_old.title = 'token sk-LEAKLEAKLEAK99';
        data.chats.c_old.messages.push({ role: 'user', content: 'auth: Bearer abc.def.ghi and cookie JSESSIONID=SECRETSESSION;' });
        var h2 = await loadCH(data);
        var l = await h2.m.executeChatHistory({ action: 'list' });
        assert.ok(JSON.stringify(l).indexOf('LEAKLEAK') === -1);
        var s = await h2.m.executeChatHistory({ action: 'search', pattern: 'cookie' });
        var js = JSON.stringify(s);
        assert.strictEqual(s.matches.length, 1);
        assert.ok(js.indexOf('SECRETSESSION') === -1 && js.indexOf('abc.def.ghi') === -1 && js.indexOf('LEAKLEAK') === -1, js);
        var g = await h2.m.executeChatHistory({ action: 'get', chat_id: 'c_old' });
        assert.ok(JSON.stringify(g).indexOf('SECRETSESSION') === -1);
    }, { tags: ['unit'] });
});

function oneChat(content, payloads) {
    return { chats: { c1: { id: 'c1', title: 'T', createdAt: 1, messages: [{ role: 'user', content: content }],
        cachedToolResults: payloads ? { cache_p: { _fcEvicted: true } } : undefined } },
        chat_payloads: payloads ? { cache_p: { id: 'cache_p', base64: payloads, at: 1 } } : {} };
}

describe('chat_history redaction leaks (PR #1201/#1202 follow-up)', function() {
    test('finding1: header/JSON/JWT/PAT/password/cookie/g_ck/AWS secrets are redacted', async function() {
        var h = await loadCH();
        var cases = [
            ['X-UserToken: abc123secretvalue', 'abc123secretvalue'],
            ['{"X-UserToken": "abc123secretvalue"}', 'abc123secretvalue'],
            ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
            ['"Authorization":"Bearer opaque.tok"', 'opaque.tok'],
            ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw end', 'SflKxwRJSMeKKF2QT4fw'],
            ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv', 'abcdefghijklmnop'],
            ['{"user_password":"Hunter2!xyz"}', 'Hunter2'],
            ['"{\\"db_password\\":\\"Hunter2!xyz\\"}"', 'Hunter2'],
            ['{"name":"JSESSIONID","value":"ABCDEF123456"}', 'ABCDEF123456'],
            ['{"domain":".x.com","name":"glide_user_route","path":"/","value":"glide.r123"}', 'glide.r123'],
            ["var g_ck = 'a1b2c3d4e5f6';", 'a1b2c3d4e5f6'],
            ['Cookie: JSESSIONID=abc; glide_user=xyz99', 'xyz99'],
            ['key AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
            ['secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
            ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI']
        ];
        cases.forEach(function(c) {
            var out = h.m._chRedact(c[0]);
            assert.ok(out.indexOf(c[1]) === -1 && out.indexOf('[redacted]') !== -1, 'leaked: ' + c[0] + ' -> ' + out);
        });
        // keys/context kept, value replaced
        assert.strictEqual(h.m._chRedact('{"X-UserToken": "v1"}'), '{"X-UserToken": "[redacted]"}');
        // no false positives on prose / SHAs
        ['Basic authentication is required', 'sha 3f786850e387550fdab836ed7e6dc881de23001b', 'reset your password today'].forEach(function(s) {
            assert.strictEqual(h.m._chRedact(s), s);
        });
    }, { tags: ['unit'] });

    test('finding8: sk- needs a word boundary and a real-looking token', async function() {
        var h = await loadCH();
        assert.strictEqual(h.m._chRedact('task-management-board'), 'task-management-board');
        assert.strictEqual(h.m._chRedact('desk-organizer2000-pro'), 'desk-organizer2000-pro');
        assert.strictEqual(h.m._chRedact('sk-short'), 'sk-short');
        assert.strictEqual(h.m._chRedact('key=sk-proj-abc123def456ghi'), 'key=[redacted]');
        assert.strictEqual(h.m._chRedact('use sk-' + 'ant-api03-abcDEF123456 now'), 'use [redacted] now');
    }, { tags: ['unit'] });

    test('finding2: excerpt window never exposes the tail of a long secret', async function() {
        var tok = 'A1b2'.repeat(40);
        var h = await loadCH(oneChat('Authorization: Bearer ' + tok + ' MARKER here'));
        var s = await h.m.executeChatHistory({ action: 'search', pattern: 'MARKER' });
        assert.strictEqual(s.matches.length, 1);
        assert.ok(s.matches[0].excerpt.indexOf('A1b2') === -1, s.matches[0].excerpt);
        assert.ok(/\[redacted\] MARKER/.test(s.matches[0].excerpt));
        var h2 = await loadCH(oneChat('x '.repeat(30) + 'ghp_' + 'Z9'.repeat(40) + ' MARKER'));
        var s2 = await h2.m.executeChatHistory({ action: 'search', pattern: 'MARKER' });
        assert.ok(s2.matches[0].excerpt.indexOf('Z9Z9') === -1, s2.matches[0].excerpt);
    }, { tags: ['unit'] });

    test('finding3: search runs on redacted text (no secret oracle)', async function() {
        var h = await loadCH(oneChat('creds {"user_password":"Hunter2xyz"} and sk-abcdefgh12345678'));
        var a = await h.m.executeChatHistory({ action: 'search', pattern: 'Hunter2', flags: '' });
        assert.strictEqual(a.matches.length, 0);
        var b = await h.m.executeChatHistory({ action: 'search', pattern: 'sk-abcd' });
        assert.strictEqual(b.matches.length, 0);
        var c = await h.m.executeChatHistory({ action: 'search', pattern: 'user_password' });
        assert.strictEqual(c.matches.length, 1);
        assert.ok(c.matches[0].excerpt.indexOf('Hunter2') === -1);
    }, { tags: ['unit'] });

    test('finding4: long punctuation-free prose is not treated as base64', async function() {
        var h = await loadCH();
        var prose = 'this is a long prose paragraph without any punctuation at all '.repeat(6);
        assert.strictEqual(h.m._chLooksBinary(prose), false);
        assert.strictEqual(h.m._chSafeSerialize(prose), prose);
        assert.strictEqual(h.m._chLooksBinary('QUJD'.repeat(200)), true);
        var wrapped = []; for (var i = 0; i < 10; i++) wrapped.push('QUJD'.repeat(19));
        assert.strictEqual(h.m._chLooksBinary(wrapped.join('\n')), true, 'line-wrapped base64');
        assert.strictEqual(h.m._chLooksBinary('"data:image/png;base64,QUJD"'), true, 'JSON-stringified data URL');
        var h2 = await loadCH(oneChat(prose + 'NEEDLE'));
        var s = await h2.m.executeChatHistory({ action: 'search', pattern: 'needle' });
        assert.strictEqual(s.matches.length, 1, 'prose is searchable');
    }, { tags: ['unit'] });

    test('finding5: nested-quantifier / overlapping-alternation patterns are rejected', async function() {
        var h = await loadCH();
        ['(a+)+$', '(a*)*b', '(a|a)*c', '(\\w|\\d)+x', '(.*x){20}', '(?:a|ab)+$', '(foo|bar)+', '(\\d{3}-){2}', '\\(a+\\)+'].forEach(function(p) {
            assert.ok(h.m._chUnsafePattern(p), 'should reject ' + p);
        });
        ['banana', '(?:foo|bar)baz', '\\d{3}-\\d{3}', 'a.*b', '[(a+)+]', '\\(a+\\)', 'https?://\\S+'].forEach(function(p) {
            assert.strictEqual(h.m._chUnsafePattern(p), null, 'should accept ' + p);
        });
        var r = await h.m.executeChatHistory({ action: 'search', pattern: '(a+)+$' });
        assert.strictEqual(r.success, false);
        assert.ok(/^Unsafe regex/.test(r.error), r.error);
    }, { tags: ['unit'] });

    test('finding5: exec runs in bounded chunks and still finds matches anywhere', async function() {
        var h = await loadCH();
        var C = h.m.CH_EXEC_CHUNK, O = h.m.CH_EXEC_OVERLAP;
        assert.ok(C <= 8192 && O > 0 && O < C);
        var filler = 'lorem ipsum, ';
        function at(pos) { var s = filler.repeat(Math.ceil(pos / filler.length) + 1).slice(0, pos); return s + 'NEEDLE' + filler.repeat(400); }
        for (var pos of [10, C - 3, C + 50, 3 * C + 7]) {
            var h2 = await loadCH(oneChat(at(pos)));
            var s = await h2.m.executeChatHistory({ action: 'search', pattern: 'NEEDLE', flags: '' });
            assert.strictEqual(s.matches.length, 1, 'match at ' + pos);
        }
    }, { tags: ['unit'] });

    test('finding6: data URLs embedded in JSON payload text are omitted', async function() {
        var inner = JSON.stringify({ shot: 'data:image/png;base64,' + 'QUJD'.repeat(300), note: 'kiwi' });
        var h = await loadCH(oneChat('hi', JSON.stringify(inner)));
        var g = await h.m.executeChatHistory({ action: 'get', chat_id: 'c1', path: 'cachedToolResults' });
        var t = g.value.cache_p._payload.text;
        assert.ok(t.indexOf('QUJDQUJD') === -1, t.slice(0, 200));
        assert.ok(/\[binary \d+ chars omitted\]/.test(t));
        assert.ok(t.indexOf('kiwi') !== -1);
        var s = await h.m.executeChatHistory({ action: 'search', pattern: 'QUJDQUJD', chat_id: 'c1', flags: '' });
        assert.strictEqual(s.matches.length, 0, 'embedded base64 is not searched');
        var du = 'data:image/jpeg;base64,/9j/AAA=';
        assert.strictEqual(h.m._chSafeSerialize('x {"a":"' + du + '"} y'), 'x {"a":"[binary ' + du.length + ' chars omitted]"} y');
    }, { tags: ['unit'] });

    test('finding7: search matches quotes/newlines inside JSON-escaped payload text', async function() {
        var inner = JSON.stringify({ rows: ['he said "hi"\nthen left'], password: 'zz9secret' });
        var h = await loadCH(oneChat('hi', JSON.stringify(inner)));
        var s = await h.m.executeChatHistory({ action: 'search', pattern: 'said "hi"\\nthen', chat_id: 'c1' });
        assert.strictEqual(s.matches.length, 1);
        assert.strictEqual(s.matches[0].json_decoded, true);
        assert.ok(s.matches[0].excerpt.indexOf('zz9secret') === -1, s.matches[0].excerpt);
        var z = await h.m.executeChatHistory({ action: 'search', pattern: 'zz9secret', chat_id: 'c1' });
        assert.strictEqual(z.matches.length, 0, 'decoded text is redacted too');
        assert.strictEqual(h.m._chJsonText('not json'), null);
        assert.strictEqual(h.m._chJsonText('[{"name":"JSESSIONID","value":"S3CRET"}]').indexOf('S3CRET'), -1);
    }, { tags: ['unit'] });
});

// PR #1204 review. NOTE: rejection logic only — the unsafe patterns are NEVER exec'd.
describe('chat_history PR #1204 review', function() {
    test('redos: strict safe subset rejects the reported bypasses (never executed)', async function() {
        var h = await loadCH();
        ['(a|\\x61)+b', '(a|A)+b', '(ab|a[b])*c', '(a{1,10}){1,10}b', '.*.*.*x', '(?<n>a+)\\k<n>+b', '(a)\\1',
         '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b', 'a{1,500}', 'x{200}', '(a)?b', 'a+b*',
         '(a|aa)'.repeat(11), 'a'.repeat(300)].forEach(function(p) {
            assert.ok(h.m._chUnsafePattern(p, 'i'), 'should reject ' + p);
        });
        assert.ok(h.m._chUnsafePattern('a', 'v'), 'v flag rejected');
        ['banana', 'token expired', '\\(literal\\)', '[\\w.-]+@example\\.com', 'error.*timeout', 'https?://\\S+',
         '(?:GET|POST) /api', '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}', '(?<y>\\d{4})-\\d{2}', 'error|fail|timeout', '[(a+)+]'].forEach(function(p) {
            assert.strictEqual(h.m._chUnsafePattern(p, 'i'), null, 'should accept ' + p);
        });
        var r = await h.m.executeChatHistory({ action: 'search', pattern: '.*.*.*x' });
        assert.strictEqual(r.success, false);
        assert.ok(/^Unsafe regex/.test(r.error) && /simpler pattern/.test(r.error), r.error);
        assert.ok(h.m.CH_EXEC_CHUNK <= 1024, 'exec chunk bounded');
        var ok = await h.m.executeChatHistory({ action: 'search', pattern: 'ban.*na' });
        assert.strictEqual(ok.success, true); assert.strictEqual(ok.matches.length, 2);
    }, { tags: ['unit'] });

    test('multi-level escaped JSON (1x/2x/3x stringify) is redacted in get and search excerpts', async function() {
        var base = '{"password":"Hunter2xyz","token":"TokVal99","note":"MARKER ok"}';
        var levels = [base], i;
        for (i = 0; i < 3; i++) levels.push(JSON.stringify(levels[levels.length - 1]));
        for (i = 0; i < levels.length; i++) {
            var s = levels[i];
            var red = (await loadCH()).m._chRedact(s);
            assert.ok(red.indexOf('Hunter2') === -1 && red.indexOf('TokVal99') === -1, i + 'x: ' + red);
            assert.ok(red.indexOf('MARKER ok') !== -1, 'context kept ' + i + 'x');
            var h = await loadCH(oneChat(s, s));
            var g = await h.m.executeChatHistory({ action: 'get', chat_id: 'c1' });
            var gp = await h.m.executeChatHistory({ action: 'get', chat_id: 'c1', path: 'cachedToolResults' });
            var se = await h.m.executeChatHistory({ action: 'search', pattern: 'MARKER', chat_id: 'c1' });
            assert.ok(se.matches.length >= 1, 'found at ' + i + 'x');
            var all = JSON.stringify([g, gp, se]);
            assert.ok(all.indexOf('Hunter2') === -1 && all.indexOf('TokVal99') === -1, 'leak at ' + i + 'x');
        }
    }, { tags: ['unit'] });

    test('unicode-escaped keys/values are redacted; plain escapes kept; redaction idempotent', async function() {
        var h = await loadCH();
        var a = h.m._chRedact('{"\\u0070assword":"x9secret"}');
        assert.ok(a.indexOf('x9secret') === -1, a);
        var b = h.m._chRedact('tok ghp_\\u0041' + 'b'.repeat(36) + ' end');
        assert.ok(b.indexOf('bbbbbbbb') === -1 && /end$/.test(b), b);
        var c = h.m._chRedact('\\"\\\\u0070assword\\":\\"zz9\\"');
        assert.ok(c.indexOf('zz9') === -1, c);
        assert.strictEqual(h.m._chRedact('say \\u0041BC'), 'say \\u0041BC');
        ['{"password":"x"}', 'Bearer abc.def', '-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----', '?token=abc1', 'Cookie: a=b', 'secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'].forEach(function(s) {
            var once = h.m._chRedact(s);
            assert.strictEqual(h.m._chRedact(once), once, 'idempotent: ' + s);
        });
    }, { tags: ['unit'] });

    test('URL query + quoted JSON generic keys redacted; prose untouched', async function() {
        var h = await loadCH();
        [['https://x.io/cb?code=AbC123xyz&state=1', 'AbC123xyz'], ['/a?token=t0k3n', 't0k3n'], ['/a?x=1&sig=S1gnat', 'S1gnat'],
         ['/a?apikey=AK99', 'AK99'], ['/a?key=K3y', 'K3y'], ['/a?secret=Sh', 'Sh&'], ['/a?x=1&amp;token=amp9', 'amp9'],
         ['{"token":"tok_abc"}', 'tok_abc'], ['{"key":"k-123"}', 'k-123'], ['{"secret":"s3"}', 's3"'], ['{"apikey":"ap1"}', 'ap1'],
         ['{"sig":"sg1"}', 'sg1'], ['{"code":"c0de"}', 'c0de'], ['{\\"token\\":\\"esc1\\"}', 'esc1']].forEach(function(c) {
            var out = h.m._chRedact(c[0]);
            assert.ok(out.indexOf(c[1]) === -1 && out.indexOf('[redacted]') !== -1, c[0] + ' -> ' + out);
        });
        assert.strictEqual(h.m._chRedact('/a?state=1&page=2'), '/a?state=1&page=2');
        ['the key point is the token count', 'code: see below', 'secret: please do not share', '{"code": 200}', 'Password: please reset'].forEach(function(s) {
            assert.strictEqual(h.m._chRedact(s), s);
        });
    }, { tags: ['unit'] });

    test('PEM, Stripe, Slack and Google API keys are redacted', async function() {
        var h = await loadCH();
        var pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1x\nQk9EWQ==\n-----END RSA PRIVATE KEY-----';
        var o = h.m._chRedact('k: ' + pem + ' after');
        assert.strictEqual(o, 'k: -----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY----- after');
        var esc = h.m._chRedact(JSON.stringify({ k: pem }));
        assert.ok(esc.indexOf('MIIEow') === -1, esc);
        assert.ok(h.m._chRedact('-----BEGIN PRIVATE KEY-----\nMIIEtrunc').indexOf('MIIEtrunc') === -1, 'truncated PEM');
        ['sk_live_' + 'a1B2'.repeat(6), 'sk_test_' + 'Z9y8'.repeat(6), 'rk_live_' + 'Q1w2'.repeat(6),
         'xoxb-123456789012-abcdefABCDEF', 'xoxp-1234-5678-abcdef', 'AIza' + 'A1b2_'.repeat(7)].forEach(function(s) {
            assert.strictEqual(h.m._chRedact('x ' + s + ' y'), 'x [redacted] y', s);
        });
        assert.strictEqual(h.m._chRedact('pk_live_publishable'), 'pk_live_publishable');
    }, { tags: ['unit'] });

    test('case-insensitive bearer/session cookies; less over-redaction', async function() {
        var h = await loadCH();
        [['bearer abc.def', 'abc.def'], ['BEARER Zm9vYmFy123', 'Zm9vYmFy123'], ['x;jsessionid=ABC123', 'ABC123'], ['JSessionId=Zz9', 'Zz9'],
         ['sessionid=abc123', 'abc123'], ['csrftoken=xyz789', 'xyz789'], ['password: Hunter2', 'Hunter2'],
         ['wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12', 'wJalr']].forEach(function(c) {
            var out = h.m._chRedact(c[0]);
            assert.ok(out.indexOf(c[1]) === -1 && out.indexOf('[redacted]') !== -1, c[0] + ' -> ' + out);
        });
        var p40 = 'src/js/tools/Abc123defGhi456/jklMno789PQ';
        assert.strictEqual(p40.length, 40);
        ['const passwordField = document.getElementById("pw")', 'Password: please reset', 'bearer of bad news',
         'see ' + p40 + ' now', 'if (password === "") return;', 'var pwd = null;'].forEach(function(s) {
            assert.strictEqual(h.m._chRedact(s), s);
        });
        assert.strictEqual(h.m._chRedact('password=hunter2'), 'password=[redacted]');
    }, { tags: ['unit'] });
});
