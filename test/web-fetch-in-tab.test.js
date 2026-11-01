// web_fetch tab_id: run the request inside an open tab as the page itself
// (wfInTabValidate / wfInTabFetchFunc / wfFetchInTab in tools/020-tool-execution.js).
// Loads the REAL slice between the WF_IN_TAB markers, drives it with a fake
// chrome.scripting, then runs the injected func against a fake page fetch.
describe('web_fetch tab_id (in-tab page-context fetch)', function() {
    var SRC = 'src/js/tools/020-tool-execution.js';
    async function load() {
        var text = await loadFile(SRC);
        var a = text.indexOf('// WF_IN_TAB_BEGIN'), b = text.indexOf('// WF_IN_TAB_END');
        if (a < 0 || b < 0) throw new Error('WF_IN_TAB markers missing');
        return new Function(text.slice(a, b) + '\nreturn { validate: wfInTabValidate, func: wfInTabFetchFunc, run: wfFetchInTab, apply: wfApplyTextBody, hint: webFetchBlockHint, resultHint: wfResultHint, isText: wfIsTextContentType, CT: WF_TEXT_CT_SRC };')();
    }
    function fakeScripting(result, capture) {
        return { executeScript: function(o) { capture.push(o); return Promise.resolve(result === undefined ? [] : [{ result: result }]); } };
    }

    it('dispatcher routes tab_id to wfFetchInTab before body build / GitHub token injection', async function() {
        var text = await loadFile(SRC);
        var i = text.indexOf("} else if (name === 'web_fetch') {");
        var tab = text.indexOf('return await wfFetchInTab(args', i);
        var body = text.indexOf('lfBuildFetchBody(args, options)', i);
        var gh = text.indexOf('var _wfAuth = await getGitHubApiAuthForUrl(args.url)', i);
        var tok = text.indexOf("'Bearer ' + _wfAuth.token", i);
        assert.ok(i > 0 && tab > i, 'tab_id branch present in web_fetch');
        assert.ok(gh > tab && tok > tab && body > tab, 'tab_id branch returns before binary body + GitHub token injection');
        // The tab branch passes the GitHub match only for hint suppression, never a token header.
        var branch = text.slice(text.lastIndexOf('if (args.tab_id != null', tab), tab + 200);
        assert.ok(/wfFetchInTab\(args, [^;]*, _wfTabGh\)/.test(branch), 'GitHub match passed as 3rd arg');
        assert.ok(!/Authorization|Bearer/.test(branch), 'no auth header built for tab_id');
    });

    it('schema exposes tab_id and tab_world', async function() {
        var t = await loadFile('src/js/core/080-tools.js');
        var i = t.indexOf("name: 'web_fetch'");
        var j = t.indexOf("name: 'local_folder'", i);
        var seg = t.slice(i, j);
        assert.ok(/tab_id: \{ type: \['integer', 'string'\]/.test(seg));
        assert.ok(/tab_world: \{ type: 'string', enum: \['ISOLATED', 'MAIN'\]/.test(seg));
        var d = seg.match(/tab_id: \{ type: \[[^\]]*\], description: '((?:[^'\\]|\\.)*)'/);
        assert.ok(d, 'tab_id description');
        assert.ok(/as the user in that page/.test(d[1]) && /cookies/.test(d[1]) && /origin/.test(d[1]), 'runs as the user (cookies, origin)');
        assert.ok(/only for the site the user asked about/.test(d[1]), 'scoped to the requested site');
        assert.ok(/never for POSTs the user didn/.test(d[1]), 'no unrequested POSTs');
    });

    it('validate: rejects bad tab ids, binary bodies, bad world, non-http urls', async function() {
        var m = await load();
        assert.ok(m.validate({ tab_id: 'abc', url: 'https://a.fr/' }).error);
        assert.ok(m.validate({ tab_id: -1, url: 'https://a.fr/' }).error);
        assert.ok(m.validate({ tab_id: 1.5, url: 'https://a.fr/' }).error);
        assert.ok(/text bodies only/.test(m.validate({ tab_id: 3, url: 'https://a.fr/', save_file: true }).error));
        assert.ok(/text bodies only/.test(m.validate({ tab_id: 3, url: 'https://a.fr/', body_base64: 'AA==' }).error));
        assert.ok(/tab_world/.test(m.validate({ tab_id: 3, url: 'https://a.fr/', tab_world: 'X' }).error));
        assert.ok(m.validate({ tab_id: 3, url: '/relative' }).error);
        assert.ok(m.validate({ tab_id: 3, url: 'javascript:alert(1)' }).error);
    });

    it('validate: normalises id, method, body, world and timeout', async function() {
        var m = await load();
        var v = m.validate({ tab_id: '42', url: 'https://www.example.com/search?q=bike' });
        assert.strictEqual(v.tabId, 42);
        assert.strictEqual(v.world, 'ISOLATED');
        assert.strictEqual(v.init.method, 'GET');
        assert.strictEqual(v.init.body, undefined);
        assert.strictEqual(v.timeoutMs, 30000);
        var p = m.validate({ tab_id: 7, url: 'https://api.x.fr/s', method: 'post', body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, tab_world: 'MAIN', timeout_ms: 999999 });
        assert.strictEqual(p.init.method, 'POST');
        assert.strictEqual(p.init.body, '{"a":1}');
        assert.strictEqual(p.init.headers['Content-Type'], 'application/json');
        assert.strictEqual(p.world, 'MAIN');
        assert.strictEqual(p.timeoutMs, 120000);
        assert.strictEqual(m.validate({ tab_id: 7, url: 'https://a.fr/', body: 'x' }).init.body, undefined, 'GET drops body');
    });

    it('run: calls executeScript with tab, world, self-contained func and args; maps success', async function() {
        var m = await load();
        var calls = [];
        var out = await m.run({ tab_id: 9, url: 'https://www.example.com/search?q=bike' },
            fakeScripting({ ok: true, status: 200, final_url: 'https://www.example.com/search?q=bike', content_type: 'text/html', body: '<html>ads</html>', page_origin: 'https://www.example.com' }, calls));
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].target, { tabId: 9 });
        assert.strictEqual(calls[0].world, 'ISOLATED');
        assert.strictEqual(typeof calls[0].func, 'function');
        assert.strictEqual(calls[0].args[0], 'https://www.example.com/search?q=bike');
        assert.strictEqual(out.success, true);
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.context, 'tab');
        assert.strictEqual(out.cross_origin, false);
        assert.strictEqual(out.body, '<html>ads</html>');
        assert.strictEqual(calls[0].args[3], m.CT, 'text content-type source passed to the page func');
    });

    it('run: HTML in-tab result gets page_title / meta_description / extracted_text like the normal path', async function() {
        var m = await load();
        var html = '<!DOCTYPE html><html><head><title>Bikes &amp; more</title><meta name="description" content="Used bikes"><style>.a{}</style></head>' +
            '<body><script>window.x=1</script><h1>Results</h1><p>Road bike, 300 EUR</p></body></html>';
        var out = await m.run({ tab_id: 9, url: 'https://shop.example.com/search?q=bike' },
            fakeScripting({ ok: true, status: 200, final_url: 'https://shop.example.com/search?q=bike', content_type: 'text/html; charset=utf-8', body: html, page_origin: 'https://shop.example.com' }, []));
        assert.strictEqual(out.success, true);
        assert.strictEqual(out.page_title, 'Bikes & more');
        assert.strictEqual(out.meta_description, 'Used bikes');
        assert.match(out.extracted_text, /Road bike, 300 EUR/);
        assert.ok(!/window\.x/.test(out.extracted_text), 'scripts stripped');
        assert.strictEqual(out.body, html, 'raw body unchanged');
        assert.strictEqual(out.hint, undefined);
        var json = await m.run({ tab_id: 9, url: 'https://shop.example.com/api' },
            fakeScripting({ ok: true, status: 200, content_type: 'application/json', body: '{"a":1}', page_origin: 'https://shop.example.com' }, []));
        assert.strictEqual(json.success, true);
        assert.strictEqual(json.body, '{"a":1}');
        assert.strictEqual(json.extracted_text, undefined);
    });

    it('run: blocked status / challenge page in the tab gets the in-tab hint (no tab_id suggestion)', async function() {
        var m = await load();
        var statuses = [401, 403, 429, 503, 999];
        for (var k = 0; k < statuses.length; k++) {
            var s = statuses[k];
            var out = await m.run({ tab_id: 9, url: 'https://shop.example.com/x' },
                fakeScripting({ ok: true, status: s, content_type: 'text/html', body: '<html><body>blocked</body></html>', retry_after: s === 429 ? '17' : '', page_origin: 'https://shop.example.com' }, []));
            assert.strictEqual(out.success, true, 'status ' + s + ' keeps success:true + status (same shape as normal path)');
            assert.strictEqual(out.status, s);
            assert.match(out.hint, new RegExp('^HTTP ' + s + ' '));
            assert.ok(!/tab_id/.test(out.hint), 'in-tab hint must not suggest tab_id: ' + out.hint);
            if (s === 429) assert.match(out.hint, /Retry-After: 17/);
        }
        var ch = await m.run({ tab_id: 9, url: 'https://shop.example.com/' },
            fakeScripting({ ok: true, status: 200, content_type: 'text/html', body: '<html><head><title>Just a moment...</title></head><body></body></html>', page_origin: 'https://shop.example.com' }, []));
        assert.strictEqual(ch.challenge_suspected, true);
        assert.ok(!/tab_id/.test(ch.hint));
        var gh = await m.run({ tab_id: 9, url: 'https://api.github.com/repos/o/r' },
            fakeScripting({ ok: true, status: 403, content_type: 'application/json', body: '{}', page_origin: 'https://github.com' }, []), { token: null });
        assert.strictEqual(gh.status, 403);
        assert.strictEqual(gh.hint, undefined, 'GitHub match suppresses the hint in-tab too');
    });

    it('run: binary responses are refused with a save_file pointer', async function() {
        var m = await load();
        var flagged = await m.run({ tab_id: 9, url: 'https://shop.example.com/a.pdf' },
            fakeScripting({ ok: true, binary: true, status: 200, content_type: 'application/pdf', final_url: 'https://shop.example.com/a.pdf', page_origin: 'https://shop.example.com' }, []));
        assert.strictEqual(flagged.success, false);
        assert.strictEqual(flagged.binary, true);
        assert.match(flagged.error, /binary \(application\/pdf\)/);
        assert.match(flagged.hint, /without tab_id and with save_file:true/);
        assert.strictEqual(flagged.body, undefined);
        var unflagged = await m.run({ tab_id: 9, url: 'https://shop.example.com/i.png' },
            fakeScripting({ ok: true, status: 200, content_type: 'image/png', body: '\u0089PNG', page_origin: 'https://shop.example.com' }, []));
        assert.strictEqual(unflagged.success, false, 're-checked outside the page func');
        assert.strictEqual(unflagged.binary, true);
        ['text/html', 'application/json', 'application/ld+json', 'image/svg+xml', 'text/csv', '', null, 'application/xml; charset=utf-8'].forEach(function(ct) {
            assert.strictEqual(m.isText(ct), true, 'text: ' + ct);
        });
        ['image/png', 'application/pdf', 'application/octet-stream', 'application/zip', 'video/mp4', 'font/woff2'].forEach(function(ct) {
            assert.strictEqual(m.isText(ct), false, 'binary: ' + ct);
        });
    });

    it('injected func: non-text content-type is not read (binary:true), Retry-After surfaced', async function() {
        var m = await load();
        var read = 0, cancelled = 0;
        var mk = function(ct, ra) {
            return function() { return Promise.resolve({ status: 429, url: 'https://shop.example.com/i', headers: { get: function(k) { return k === 'content-type' ? ct : (k === 'retry-after' ? ra : null); } },
                body: { cancel: function() { cancelled++; } }, text: function() { read++; return Promise.resolve('x'); } }); };
        };
        var f = new Function('fetch', 'location', 'return (' + m.func.toString() + ');')(mk('image/png', ''), { origin: 'https://shop.example.com' });
        var r = await f('https://shop.example.com/i', { method: 'GET', headers: {} }, 1000, m.CT);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.binary, true);
        assert.strictEqual(r.body, undefined);
        assert.strictEqual(read, 0, 'binary body never read as text');
        assert.strictEqual(cancelled, 1);
        var g = new Function('fetch', 'location', 'return (' + m.func.toString() + ');')(mk('text/plain', '9'), { origin: 'https://shop.example.com' });
        var t = await g('https://shop.example.com/i', { method: 'GET', headers: {} }, 1000, m.CT);
        assert.strictEqual(t.binary, undefined);
        assert.strictEqual(t.body, 'x');
        assert.strictEqual(t.retry_after, '9');
    });

    it('run: surfaces executeScript errors, empty results, and cross-origin hints', async function() {
        var m = await load();
        var boom = await m.run({ tab_id: 9, url: 'https://a.fr/' }, { executeScript: function() { return Promise.reject(new Error('No tab with id: 9')); } });
        assert.strictEqual(boom.success, false);
        assert.ok(/No tab with id: 9/.test(boom.error));
        var empty = await m.run({ tab_id: 9, url: 'https://a.fr/' }, fakeScripting(undefined, []));
        assert.strictEqual(empty.success, false);
        var cors = await m.run({ tab_id: 9, url: 'https://api.b.fr/x' }, fakeScripting({ ok: false, error: 'Failed to fetch', page_origin: 'https://www.b.fr' }, []));
        assert.strictEqual(cors.success, false);
        assert.ok(/cross-origin/.test(cors.hint));
        var noScripting = await m.run({ tab_id: 9, url: 'https://a.fr/' }, null);
        assert.ok(/chrome.scripting/.test(noScripting.error));
        var invalid = await m.run({ tab_id: 'x', url: 'https://a.fr/' }, fakeScripting({ ok: true }, []));
        assert.strictEqual(invalid.success, false);
    });

    it('injected func: page fetch with credentials:include, returns status/body/origin', async function() {
        var m = await load();
        var seen = null;
        var fakeFetch = function(url, opts) {
            seen = { url: url, opts: opts };
            return Promise.resolve({ status: 200, url: url, headers: { get: function() { return 'application/json'; } }, text: function() { return Promise.resolve('{"ads":[1]}'); } });
        };
        var f = new Function('fetch', 'location', 'return (' + m.func.toString() + ');')(fakeFetch, { origin: 'https://www.example.com' });
        var r = await f('https://api.example.com/search', { method: 'POST', headers: { a: '1' }, body: '{}' }, 1000);
        assert.strictEqual(seen.opts.credentials, 'include');
        assert.strictEqual(seen.opts.method, 'POST');
        assert.strictEqual(seen.opts.body, '{}');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body, '{"ads":[1]}');
        assert.strictEqual(r.page_origin, 'https://www.example.com');
        var bad = new Function('fetch', 'location', 'return (' + m.func.toString() + ');')(function() { return Promise.reject(new TypeError('Failed to fetch')); }, { origin: 'https://x.fr' });
        var e = await bad('https://y.fr/', { method: 'GET', headers: {} }, 1000);
        assert.strictEqual(e.ok, false);
        assert.ok(/Failed to fetch/.test(e.error));
    });
});
