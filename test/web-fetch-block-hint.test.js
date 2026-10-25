// web_fetch block hint (tools/020-tool-execution.js): webFetchBlockHint
// (401/403/429/503/999, normal + in-tab wording), the vendor-neutral 2xx
// challenge heuristic (wfChallengeSignal / wfResultHint), the shared HTML
// extraction (wfApplyTextBody), the executeTool wiring, and the matching
// guidance in the web_fetch description. Skipped for the GitHub host family.

function _wfbhChrome(store) {
    return {
        storage: { local: { get: function(keys, cb) { cb(store || {}); } } },
        runtime: { id: 'test', getURL: function(p) { return 'chrome-extension://test/' + p; } }
    };
}

function _wfbhLoad(fetchImpl) {
    return loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: {
        chrome: _wfbhChrome({}),
        window: fakeWindow(),
        fetch: fetchImpl || function() { throw new Error('fetch not stubbed'); },
        requestProgrammaticToolApproval: async function() { return { allowed: true }; },
        normalizeGitHubInstanceUrl: function(u) { return (u || 'https://github.com').replace(/\/+$/, ''); }
    } });
}

function _wfbhResponse(status, body, headers) {
    var h = Object.assign({ 'content-type': 'text/html; charset=utf-8' }, headers || {});
    return {
        status: status,
        headers: { get: function(k) { var v = h[String(k).toLowerCase()]; return v === undefined ? null : v; } },
        text: async function() { return body; },
        blob: async function() { return null; }
    };
}

function _wfbhFn(M, name) { return M[name] || (M.__scope && M.__scope[name]); }

// Run a body through the real extraction + hint pipeline (as both paths do).
function _wfbhPipeline(M, status, body, ct, opts) {
    var r = { success: true, status: status, content_type: ct };
    var isHtml = _wfbhFn(M, 'wfApplyTextBody')(r, body, ct);
    var h = _wfbhFn(M, 'wfResultHint')(r, body, isHtml, null, opts || {});
    if (h) r.hint = h;
    return r;
}

describe('webFetchBlockHint wording', function() {
    var M;
    beforeEach(async function() { if (!M) M = await _wfbhLoad(); });

    test('403: may mean bot protection; retry with tab_id or read via iframe_tool', async function() {
        var h = M.webFetchBlockHint(403, null);
        assert.match(h, /^HTTP 403 may mean bot protection, not that the site is unreachable/);
        assert.match(h, /Retry with tab_id/);
        assert.match(h, /navigate \{tab_id:"new"/);
        assert.match(h, /close it afterwards/);
        assert.match(h, /get_dom\/get_visible_text/);
        assert.match(h, /list_instances otherTabs/);
        assert.match(h, /parent/);
        assert.match(h, /Never solve CAPTCHAs/);
    }, { tags: ['unit'], timeout: 5000 });

    test('429: rate limit first, back off, Retry-After quoted when present', async function() {
        var h = M.webFetchBlockHint(429, null);
        assert.match(h, /^HTTP 429 means rate limited/);
        assert.match(h, /back off/);
        assert.match(h, /honor Retry-After/);
        assert.match(h, /tight loop/);
        assert.match(h, /may be bot protection/);
        var r = M.webFetchBlockHint(429, null, { retryAfter: ' 30 ' });
        assert.match(r, /\(Retry-After: 30\)/);
        assert.ok(!/honor Retry-After/.test(r));
    }, { tags: ['unit'], timeout: 5000 });

    test('503: bot protection OR maintenance/outage, Retry-After when present', async function() {
        var h = M.webFetchBlockHint(503, null);
        assert.match(h, /^HTTP 503 may be bot protection/);
        assert.match(h, /maintenance/);
        assert.ok(!/Retry-After/.test(h));
        assert.match(M.webFetchBlockHint(503, null, { retryAfter: '120' }), /Retry-After: 120/);
    }, { tags: ['unit'], timeout: 5000 });

    test('999: non-standard bot wall', async function() {
        var h = M.webFetchBlockHint(999, null);
        assert.match(h, /^HTTP 999 is a non-standard bot-wall response/);
        assert.match(h, /Retry with tab_id/);
    }, { tags: ['unit'], timeout: 5000 });

    test('401: not logged in, not bot protection', async function() {
        var h = M.webFetchBlockHint(401, null);
        assert.match(h, /^HTTP 401 /);
        assert.match(h, /not logged in/);
        assert.match(h, /already sends the browser's cookies/);
        assert.match(h, /tab_id/);
        assert.ok(!/bot protection/i.test(h), '401 must not be called bot protection');
    }, { tags: ['unit'], timeout: 5000 });

    test('in-tab variants never mention tab_id and point to reading the page / asking the user', async function() {
        [401, 403, 429, 503, 999].forEach(function(s) {
            var h = M.webFetchBlockHint(s, null, { inTab: true, retryAfter: '5' });
            assert.strictEqual(typeof h, 'string', 'status ' + s);
            assert.match(h, new RegExp('^HTTP ' + s + ' '));
            assert.ok(!/tab_id/.test(h), 'in-tab hint must not suggest tab_id (' + s + '): ' + h);
            assert.match(h, /in (the|that|the user's) tab/);
            if (s === 401) assert.match(h, /log in to the site in that tab/);
            else { assert.match(h, /get_visible_text\/get_dom/); assert.match(h, /ask the user/); }
        });
        var c = M.webFetchBlockHint(200, null, { inTab: true, challenge: true, title: 'Just a moment...' });
        assert.ok(!/tab_id/.test(c));
        assert.match(c, /title: "Just a moment\.\.\."/);
    }, { tags: ['unit'], timeout: 5000 });

    test('hint absent for 200/204/301/404/500 (no challenge flag)', async function() {
        [200, 204, 301, 404, 500].forEach(function(s) { assert.strictEqual(M.webFetchBlockHint(s, null), null, 'status ' + s); });
    }, { tags: ['unit'], timeout: 5000 });

    test('hint absent for the GitHub API base (real matcher), present elsewhere', async function() {
        var auth = await M.getGitHubApiAuthForUrl('https://api.github.com/repos/o/r');
        assert.ok(auth, 'api.github.com must match the configured REST base');
        [401, 403, 429, 503, 999].forEach(function(s) {
            assert.strictEqual(M.webFetchBlockHint(s, auth), null, 'gh ' + s);
            assert.strictEqual(M.webFetchBlockHint(s, auth, { inTab: true }), null, 'gh in-tab ' + s);
        });
        assert.strictEqual(_wfbhFn(M, 'wfResultHint')({ status: 403 }, '', false, auth, {}), null);
        var other = await M.getGitHubApiAuthForUrl('https://shop.example.com/x');
        assert.strictEqual(other, null);
        assert.strictEqual(typeof M.webFetchBlockHint(403, other), 'string');
    }, { tags: ['unit'], timeout: 5000 });

    test('no vendor or site names in hint/challenge sources', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var a = src.indexOf('// WF_IN_TAB_BEGIN'), b = src.indexOf('// WF_IN_TAB_END');
        var seg = src.slice(a, b);
        assert.ok(a > 0 && b > a);
        assert.ok(!/datadome|cloudflare|perimeterx|akamai|imperva|captcha-delivery|kasada|incapsula/i.test(seg), 'vendor-neutral');
        assert.ok(!/https?:\/\/(?!shop\.example\.com|api\.github\.com)[\w.-]+\.\w+/i.test(seg), 'no site-specific URLs in the hint/challenge slice');
        [401, 403, 429, 503, 999].forEach(function(s) {
            assert.ok(!/datadome|cloudflare|perimeterx|akamai|imperva/i.test(M.webFetchBlockHint(s, null)));
        });
    }, { tags: ['unit'], timeout: 5000 });
});

describe('2xx challenge-page heuristic (vendor-neutral)', function() {
    var M;
    beforeEach(async function() { if (!M) M = await _wfbhLoad(); });
    var LONG = new Array(120).join('Robots have long fascinated writers and engineers alike. ');

    test('positives: "Just a moment..." title, noscript "enable JavaScript and cookies", "verify you are human"', async function() {
        var cases = [
            '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div>Checking</div><script>var a=1;</script></body></html>',
            '<html><head><title>shop.example.com</title></head><body><noscript>Please enable JavaScript and cookies to continue</noscript><script>x()</script></body></html>',
            '<html><head><title>Security check</title></head><body><h1>Please verify you are human</h1><p>Press and hold.</p></body></html>'
        ];
        cases.forEach(function(body, i) {
            var r = _wfbhPipeline(M, 200, body, 'text/html');
            assert.strictEqual(r.challenge_suspected, true, 'case ' + i);
            assert.match(r.hint, /^HTTP 200 but the page looks like a verification \/ bot-protection challenge/, 'case ' + i);
            assert.match(r.hint, /Retry with tab_id/);
            assert.strictEqual(r.body, body, 'raw body untouched');
        });
        var t = _wfbhPipeline(M, 200, cases[0], 'text/html');
        assert.match(t.hint, /\(title: "Just a moment\.\.\."\)/);
        var tab = _wfbhPipeline(M, 200, cases[1], 'text/html', { inTab: true });
        assert.strictEqual(tab.challenge_suspected, true);
        assert.ok(!/tab_id/.test(tab.hint), 'in-tab challenge hint has no tab_id');
    }, { tags: ['unit'], timeout: 5000 });

    test('negatives: long article mentioning "Are you a robot?", short "Robot vacuum deals", JSON, 404, normal page', async function() {
        var article = '<html><head><title>Are you a robot? A history</title></head><body><article><h1>Are you a robot?</h1><p>' + LONG + '</p></article></body></html>';
        var ra = _wfbhPipeline(M, 200, article, 'text/html');
        assert.ok(ra.extracted_text.length > 1500);
        assert.strictEqual(ra.challenge_suspected, undefined, 'long article');
        assert.strictEqual(ra.hint, undefined);

        var vac = _wfbhPipeline(M, 200, '<html><head><title>Robot vacuum deals</title></head><body><p>Best robot vacuums this week, from $99.</p></body></html>', 'text/html');
        assert.strictEqual(vac.challenge_suspected, undefined, 'robot vacuum');
        assert.strictEqual(vac.hint, undefined);

        var json = _wfbhPipeline(M, 200, '{"title":"Just a moment...","msg":"verify you are human"}', 'application/json');
        assert.strictEqual(json.challenge_suspected, undefined, 'JSON body');
        assert.strictEqual(json.page_title, undefined);
        assert.strictEqual(json.hint, undefined);

        var nf = _wfbhPipeline(M, 404, '<html><head><title>Just a moment...</title></head><body></body></html>', 'text/html');
        assert.strictEqual(nf.challenge_suspected, undefined, '404 is never a challenge');
        assert.strictEqual(nf.hint, undefined);

        var ok = _wfbhPipeline(M, 200, '<html><head><title>Shop</title><meta name="description" content="Bikes &amp; parts"></head><body><h1>Bikes</h1><p>Road bike, 300 EUR</p></body></html>', 'text/html');
        assert.strictEqual(ok.challenge_suspected, undefined);
        assert.strictEqual(ok.hint, undefined);
        assert.strictEqual(ok.page_title, 'Shop');
        assert.strictEqual(ok.meta_description, 'Bikes & parts');
        assert.match(ok.extracted_text, /Road bike, 300 EUR/);
    }, { tags: ['unit'], timeout: 5000 });

    test('weak phrases: app loader / robot quiz not flagged; title or second signal flags', async function() {
        var loader = _wfbhPipeline(M, 200, '<html><head><title>Dashboard</title></head><body><div id="app"><p>Just a moment, loading your dashboard\u2026</p></div><script>boot()</script></body></html>', 'text/html');
        assert.strictEqual(loader.challenge_suspected, undefined, 'app loader');
        assert.strictEqual(loader.hint, undefined);

        var quiz = _wfbhPipeline(M, 200, '<html><head><title>Robot quiz</title></head><body><h1>Are you a robot?</h1><p>Take our 2-minute quiz and find out.</p></body></html>', 'text/html');
        assert.strictEqual(quiz.challenge_suspected, undefined, 'robot quiz teaser');
        assert.strictEqual(quiz.hint, undefined);

        var titled = _wfbhPipeline(M, 200, '<html><head><title>Just a moment...</title></head><body><p>Loading</p></body></html>', 'text/html');
        assert.strictEqual(titled.challenge_suspected, true, 'weak phrase in title');
        assert.ok(!/access block/.test(titled.hint));

        var strong = _wfbhPipeline(M, 200, '<html><head><title>example.com</title></head><body><p>Please verify you are human to continue.</p></body></html>', 'text/html');
        assert.strictEqual(strong.challenge_suspected, true, 'strong phrase in body');

        var two = _wfbhPipeline(M, 200, '<html><head><title>Error</title></head><body><h1>Access denied</h1><p>Please wait while we check your request.</p></body></html>', 'text/html');
        assert.strictEqual(two.challenge_suspected, true, 'two weak phrases in body');
        assert.match(two.hint, /bot-protection challenge or access block/);

        var mixed = _wfbhPipeline(M, 200, '<html><head><title>Hold on</title></head><body><p>Just a moment</p><noscript>Checking your browser before accessing the site.</noscript></body></html>', 'text/html');
        assert.strictEqual(mixed.challenge_suspected, true, 'weak body + strong noscript');

        var once = _wfbhPipeline(M, 200, '<html><head><title>App</title></head><body><p>Please wait</p><noscript>Please wait</noscript></body></html>', 'text/html');
        assert.strictEqual(once.challenge_suspected, undefined, 'same weak phrase twice is one signal');
    }, { tags: ['unit'], timeout: 5000 });

    test('large bodies (>150KB) are never flagged', async function() {
        var big = '<html><head><title>Just a moment...</title></head><body><script>' + new Array(160001).join('x') + '</script></body></html>';
        var r = _wfbhPipeline(M, 200, big, 'text/html');
        assert.strictEqual(r.challenge_suspected, undefined);
    }, { tags: ['unit'], timeout: 5000 });

    test('wfApplyTextBody caps extracted_text, keeps raw body, non-HTML gets body only', async function() {
        var apply = _wfbhFn(M, 'wfApplyTextBody');
        var huge = '<html><body><p>' + new Array(70001).join('a') + '</p></body></html>';
        var r = {};
        assert.strictEqual(apply(r, huge, 'text/html'), true);
        assert.strictEqual(r.body, huge);
        assert.ok(r.extracted_text.length < 60200);
        assert.match(r.extracted_text, /extracted_text truncated/);
        var j = {};
        assert.strictEqual(apply(j, '{"a":1}', 'application/json'), false);
        assert.strictEqual(j.body, '{"a":1}');
        assert.strictEqual(j.extracted_text, undefined);
        var sniff = {};
        assert.strictEqual(apply(sniff, '<!DOCTYPE html><html><head><title>T</title></head><body>x</body></html>', ''), true, 'sniffed without content-type');
        assert.strictEqual(sniff.page_title, 'T');
    }, { tags: ['unit'], timeout: 5000 });
});

describe('web_fetch result wiring (normal path)', function() {
    test('executeTool web_fetch: 403 hint, 429 Retry-After, 200 challenge, none on 200 / GitHub API 403', async function() {
        var next = null;
        var M = await _wfbhLoad(async function() { return next; });
        if (typeof M.executeTool !== 'function') { skipTest('executeTool not loadable in sandbox'); return; }
        next = _wfbhResponse(403, '<html><head><title>x</title></head><body>Please enable JS</body></html>');
        var r = await M.executeTool('web_fetch', { url: 'https://shop.example.com/search?q=1' }, 0, {});
        assert.strictEqual(r && r.success, true, 'web_fetch failed: ' + JSON.stringify(r).slice(0, 200));
        assert.strictEqual(r.status, 403);
        assert.strictEqual(typeof r.body, 'string');
        assert.strictEqual(r.page_title, 'x');
        assert.match(r.hint, /^HTTP 403 may mean bot protection/);

        next = _wfbhResponse(429, 'slow down', { 'content-type': 'text/plain', 'retry-after': '42' });
        var rl = await M.executeTool('web_fetch', { url: 'https://shop.example.com/api' }, 0, {});
        assert.strictEqual(rl.status, 429);
        assert.match(rl.hint, /Retry-After: 42/);

        next = _wfbhResponse(200, '<html><head><title>Just a moment...</title></head><body></body></html>');
        var ch = await M.executeTool('web_fetch', { url: 'https://shop.example.com/' }, 0, {});
        assert.strictEqual(ch.status, 200);
        assert.strictEqual(ch.challenge_suspected, true);
        assert.match(ch.hint, /verification \/ bot-protection challenge/);

        next = _wfbhResponse(200, '<html><head><title>Shop</title></head><body><p>Road bike</p></body></html>');
        var ok = await M.executeTool('web_fetch', { url: 'https://shop.example.com/' }, 0, {});
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.hint, undefined);
        assert.strictEqual(ok.challenge_suspected, undefined);
        assert.match(ok.extracted_text, /Road bike/);

        next = _wfbhResponse(403, '{"message":"rate limit"}', { 'content-type': 'application/json' });
        var gh = await M.executeTool('web_fetch', { url: 'https://api.github.com/repos/o/r' }, 0, {});
        assert.strictEqual(gh.status, 403);
        assert.strictEqual(gh.hint, undefined);
    }, { tags: ['unit'], timeout: 10000 });
});

describe('web_fetch description guidance', function() {
    test('full description and catalog line carry the bot-protection / rate-limit guidance', async function() {
        var src = await loadFile('src/js/core/080-tools.js');
        var i = src.indexOf("name: 'web_fetch'");
        assert.ok(i > 0);
        var desc = src.slice(i, src.indexOf('parameters:', i));
        assert.match(desc, /403\/503\/999 may mean bot protection, not an unreachable site/);
        assert.match(desc, /503 can also be maintenance\/outage/);
        assert.match(desc, /429 = rate limit: wait and back off/);
        assert.match(desc, /challenge_suspected:true/);
        assert.ok(!/401\/403/.test(desc), '401 is not grouped with bot protection');
        assert.match(desc, /retry with tab_id/);
        assert.match(desc, /iframe_tool navigate \{tab_id:"new"\} and close it afterwards/);
        assert.match(desc, /iframe_tool get_dom\/get_visible_text/);
        assert.match(desc, /401 usually means not logged in/);
        assert.match(desc, /Never solve CAPTCHAs/);
        assert.ok(!/datadome|cloudflare|perimeterx/i.test(desc));
        var cat = src.match(/\n\s+web_fetch: '([^\n]*)',/);
        assert.ok(cat, 'catalog line');
        assert.match(cat[1], /403\/503\/999 = may be bot protection \(429 = rate limit, back off\): retry with tab_id/);
        assert.match(cat[1], /401 = likely not logged in/);
    }, { tags: ['unit'], timeout: 5000 });
});
