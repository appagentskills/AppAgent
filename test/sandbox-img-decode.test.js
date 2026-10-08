// Runs the REAL sandbox.html inline script against an in-memory fake
// HTMLImageElement whose native decode() never settles (the hidden offscreen
// frame behavior), and checks the bootstrap wrapper still settles.
var sandboxHtml = await loadFile('src/platform/extension/sandbox.html');
var sandboxScript = sandboxHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1];

function makeImgClass(nativeImpl) {
    function FakeImg() { this.complete = false; this.naturalWidth = 0; this._l = {}; this.nativeCalls = 0; }
    FakeImg.prototype.addEventListener = function(t, f) { (this._l[t] = this._l[t] || []).push(f); };
    FakeImg.prototype.removeEventListener = function(t, f) { this._l[t] = (this._l[t] || []).filter(function(g) { return g !== f; }); };
    FakeImg.prototype.fire = function(t) { (this._l[t] || []).slice().forEach(function(f) { f({ type: t }); }); };
    FakeImg.prototype.listenerCount = function() { var n = 0, l = this._l; Object.keys(l).forEach(function(k) { n += l[k].length; }); return n; };
    FakeImg.prototype.decode = nativeImpl || function() { this.nativeCalls++; return new Promise(function() {}); };
    return FakeImg;
}
function boot(Img) {
    var w = fakeWindow({
        setTimeout: function() { throw new Error('decode must not use timers'); },
        clearTimeout: function() {},
        addEventListener: function() {},
        HTMLImageElement: Img
    });
    w.parent = { postMessage: function() {} };
    new Function('window', sandboxScript)(w);
    return w;
}
function state(p) {
    var s = 'pending';
    p.then(function() { s = 'resolved'; }, function(e) { s = 'rejected:' + (e && e.name); });
    return function() { return s; };
}
async function flush() { for (var i = 0; i < 5; i++) await Promise.resolve(); }

describe('sandbox safe img.decode()', function() {
    test('resolves immediately for an already-loaded image even if native decode never settles', async function() {
        var Img = makeImgClass(); boot(Img);
        var img = new Img(); img.complete = true; img.naturalWidth = 640;
        var s = state(img.decode()); await flush();
        assert.strictEqual(s(), 'resolved');
        assert.strictEqual(img.nativeCalls, 1, 'native decode kept as a race');
        assert.strictEqual(img.listenerCount(), 0, 'listeners cleaned up');
    }, { tags: ['unit'], timeout: 2000 });

    test('resolves on load event while still loading', async function() {
        var Img = makeImgClass(); boot(Img);
        var img = new Img();
        var s = state(img.decode()); await flush();
        assert.strictEqual(s(), 'pending');
        img.complete = true; img.naturalWidth = 10; img.fire('load'); await flush();
        assert.strictEqual(s(), 'resolved');
        assert.strictEqual(img.listenerCount(), 0);
    }, { tags: ['unit'], timeout: 2000 });

    test('rejects with EncodingError on error event and on complete-but-broken image', async function() {
        var Img = makeImgClass(); boot(Img);
        var a = new Img(); var sa = state(a.decode());
        a.complete = true; a.fire('error'); await flush();
        assert.strictEqual(sa(), 'rejected:EncodingError');
        var b = new Img(); b.complete = true; b.naturalWidth = 0;
        var sb = state(b.decode()); await flush();
        assert.strictEqual(sb(), 'rejected:EncodingError');
    }, { tags: ['unit'], timeout: 2000 });

    test('native resolution still wins when it settles first', async function() {
        var Img = makeImgClass(function() { return Promise.resolve(); }); boot(Img);
        var img = new Img();
        var s = state(img.decode()); await flush();
        assert.strictEqual(s(), 'resolved');
        assert.strictEqual(img.listenerCount(), 0);
    }, { tags: ['unit'], timeout: 2000 });

    test('install is idempotent and a no-op without HTMLImageElement', async function() {
        var Img = makeImgClass(); var w = boot(Img);
        var wrapped = Img.prototype.decode;
        assert.strictEqual(wrapped.__appagentSafeDecode, true);
        assert.strictEqual(w._installSafeImageDecode(w), true);
        assert.strictEqual(Img.prototype.decode, wrapped, 'not double-wrapped');
        assert.strictEqual(w._installSafeImageDecode({}), false);
    }, { tags: ['unit'], timeout: 2000 });
});
