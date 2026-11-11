// Pasting text + images (web page, Docs, Slack, email): the <img> elements of
// clipboard text/html are attached as images — app/050-image-attachments.js.
describe('composer paste: images inside rich text are attached', function() {
    function fakeDoc() {
        return { body: { id: 'body' }, documentElement: {}, activeElement: null,
            getElementById: function() { return null; }, addEventListener: function() {} };
    }
    async function load(extra) {
        var env = { fetched: [], read: [], snacks: [] };
        function F(parts, name, o) { this.parts = parts; this.name = name; this.type = (o && o.type) || ''; this.size = 10; }
        function FR() {}
        FR.prototype.readAsDataURL = function(f) { env.read.push(f); };
        FR.prototype.readAsText = function(f) { env.read.push(f); };
        var globals = Object.assign({ window: fakeWindow(), chrome: fakeChrome(), document: fakeDoc(),
            currentView: 'chat', currentChatId: 'chat-1',
            File: F, FileReader: FR, t: function(k) { return k; }, N_: function(k) { return k; },
            showSnackbar: function(m, kind) { env.snacks.push(kind + ':' + m); },
            fetch: function(url) {
                env.fetched.push(url);
                if (/fail/.test(url)) return Promise.resolve({ ok: false, status: 404 });
                var type = /\.html$/.test(url) ? 'text/html' : (/noext/.test(url) ? '' : 'image/png');
                return Promise.resolve({ ok: true, status: 200, blob: function() { return Promise.resolve({ type: type, size: 100 }); } });
            } }, extra || {});
        env.m = await loadModules(['src/js/app/050-image-attachments.js'], { lenient: true, globals: globals });
        return env;
    }
    function pasteEvent(data, items) {
        var area = { id: 'message-input' };
        var e = { target: { closest: function() { return area; } }, prevented: 0,
            clipboardData: { items: items || [{ type: 'text/plain' }, { type: 'text/html' }],
                getData: function(type) { return data[type] || ''; } } };
        e.preventDefault = function() { e.prevented++; };
        return e;
    }
    async function settle() { for (var i = 0; i < 10; i++) await new Promise(function(r) { setTimeout(r, 0); }); }

    test('extractPastedHtmlImageSources: schemes, base, dedupe, entities, cap', async function() {
        var env = await load();
        var x = env.m.extractPastedHtmlImageSources;
        assert.deepStrictEqual(x('<p>no images</p>'), []);
        assert.deepStrictEqual(x(null), []);
        var html = '<base href="https://ex.com/dir/"><img src="data:image/png;base64,AAA"><IMG alt=x SRC=\'https://a.com/p.png?a=1&amp;b=2\'>' +
            '<img src="//cdn.com/c.jpg"><img src="rel/d.gif"><img src="blob:https://x/1"><img src="file:///tmp/e.png">' +
            '<img src="cid:abc"><img src="https://a.com/p.png?a=1&amp;b=2"><img src=https://u.com/u.webp>';
        assert.deepStrictEqual(x(html), ['data:image/png;base64,AAA', 'https://a.com/p.png?a=1&b=2', 'https://cdn.com/c.jpg',
            'https://ex.com/dir/rel/d.gif', 'https://u.com/u.webp']);
        assert.deepStrictEqual(x('<img src="rel.png">'), [], 'relative without <base> is skipped');
        var many = ''; for (var i = 0; i < 15; i++) many += '<img src="https://a.com/' + i + '.png">';
        assert.strictEqual(x(many).length, 10, 'capped at 10');
    }, { tags: ['unit'], timeout: 5000 });

    test('text + html images: images attached, text paste stays native', async function() {
        var env = await load();
        var e = pasteEvent({ 'text/plain': 'hello world', 'text/html': '<p>hello</p><img src="https://a.com/x/pic.png"><p>world</p><img src="data:image/png;base64,AAA">' });
        env.m.handlePasteForImages(e);
        assert.strictEqual(e.prevented, 0, 'text paste not blocked');
        await settle();
        assert.deepStrictEqual(env.fetched, ['https://a.com/x/pic.png', 'data:image/png;base64,AAA']);
        assert.deepStrictEqual(env.read.map(function(f) { return f.name + '|' + f.type; }).sort(),
            ['pasted-image-2|image/png', 'pic.png|image/png']);
        assert.deepStrictEqual(env.snacks, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('image file item present: html <img> not fetched again (no duplicate)', async function() {
        var env = await load();
        var e = pasteEvent({ 'text/plain': 'caption', 'text/html': '<img src="https://a.com/pic.png">' },
            [{ type: 'image/png', getAsFile: function() { return { name: 'pic.png', type: 'image/png', size: 10 }; } }, { type: 'text/html' }]);
        env.m.handlePasteForImages(e);
        await settle();
        assert.deepStrictEqual(env.fetched, []);
        assert.strictEqual(env.read.length, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('failures are skipped with one warning; non-images rejected; image-only html prevents default', async function() {
        var env = await load();
        var e = pasteEvent({ 'text/html': '<img src="https://a.com/fail.png"><img src="https://a.com/page.html"><img src="https://a.com/ok.png"><img src="https://a.com/noext">' });
        env.m.handlePasteForImages(e);
        assert.strictEqual(e.prevented, 1, 'no text: nothing native to paste');
        await settle();
        assert.deepStrictEqual(env.read.map(function(f) { return f.name; }), ['ok.png']);
        assert.strictEqual(env.snacks.length, 1);
        assert.ok(/^warning:/.test(env.snacks[0]));
    }, { tags: ['unit'], timeout: 5000 });

    test('outside chat/home: nothing fetched, info snackbar', async function() {
        var env = await load({ currentView: 'settings' });
        env.m.handlePasteForImages(pasteEvent({ 'text/plain': 'x', 'text/html': '<img src="https://a.com/p.png">' }));
        await settle();
        assert.deepStrictEqual(env.fetched, []);
        assert.strictEqual(env.snacks.length, 1);
        assert.ok(/^info:/.test(env.snacks[0]));
    }, { tags: ['unit'], timeout: 5000 });
});
