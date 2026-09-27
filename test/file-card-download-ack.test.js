// A3A3-02: get_file's download card (src/js/tools/040-file-store.js) posted
// {type:'widgetDownload'} to the parent and flipped to "\u2705 Sent" after 300 ms
// no matter what, leaving the button disabled for good. The parent listener
// (src/js/ui/070-dashboard-ui.js) opened the tab with no result handling and
// never replied. Now the parent acks {type:'widgetDownloadResult',reqId,ok,error}
// to the widget, and the card shows the real outcome: it re-enables on failure,
// or after a 5 s fallback when no ack arrives.
// Both REAL sources are sliced and evaluated (the idiom used by
// test/global-escape-pin-menu.test.js). Only chrome/DOM/timer effects are stubbed.

async function a3a3Flush() {
    // Enough microtask turns for Promise.resolve().then(create).then(ok, fail),
    // including a rejected thenable being adopted.
    for (var i = 0; i < 20; i++) await Promise.resolve();
}

describe('A3A3-02 widgetDownload listener acks the real outcome', function() {
    var FROM = '// Listen for download requests from widgets';
    var TO = '// Listen for tool calls from widgets via postMessage';

    // create(opts) -> the fake chrome.tabs.create implementation.
    async function loadListener(create) {
        var src = await loadFile('src/js/ui/070-dashboard-ui.js');
        var a = src.indexOf(FROM), b = src.indexOf(TO, a);
        assert.ok(a >= 0 && b > a, 'widgetDownload listener anchors present in 070-dashboard-ui.js');
        var body = src.slice(a, b);
        var handlers = [], created = [];
        var win = { addEventListener: function(type, fn) { if (type === 'message') handlers.push(fn); } };
        var chromeStub = {
            runtime: { getURL: function(p) { return 'chrome-extension://ext/' + p; } },
            tabs: { create: function(o) { created.push(o && o.url); return create(o); } }
        };
        Function('window', 'chrome', '_isWidgetSource', body)(win, chromeStub, function(s) { return !!(s && s.isWidget); });
        assert.strictEqual(handlers.length, 1, 'the sliced source registers exactly one message listener');
        return { handler: handlers[0], created: created };
    }
    function source(isWidget) {
        var s = { isWidget: isWidget, posted: [] };
        s.postMessage = function(msg, origin) { s.posted.push({ msg: msg, origin: origin }); };
        return s;
    }
    function download(src, reqId) {
        return { source: src, data: { type: 'widgetDownload', reqId: reqId, fileId: 'file 1', name: 'a&b.pdf' } };
    }

    test('replies ok:false with the matching reqId when tabs.create rejects, then ok:true once it resolves', async function() {
        var mode = 'reject';
        var l = await loadListener(function() {
            return mode === 'reject' ? Promise.reject(new Error('No tab for you')) : Promise.resolve({ id: 7 });
        });
        var w = source(true);
        l.handler(download(w, 'd1'));
        await a3a3Flush();
        assert.deepStrictEqual(w.posted, [{
            msg: { type: 'widgetDownloadResult', reqId: 'd1', ok: false, error: 'No tab for you' }, origin: '*'
        }], 'a failed tab open is acked as ok:false to the calling widget');

        mode = 'resolve';
        l.handler(download(w, 'd2'));
        await a3a3Flush();
        assert.strictEqual(w.posted.length, 2);
        assert.strictEqual(w.posted[1].msg.type, 'widgetDownloadResult');
        assert.strictEqual(w.posted[1].msg.reqId, 'd2');
        assert.strictEqual(w.posted[1].msg.ok, true, 'a successful tab open is acked as ok:true');
        assert.deepStrictEqual(l.created, [
            'chrome-extension://ext/file-download.html?id=file%201&name=a%26b.pdf',
            'chrome-extension://ext/file-download.html?id=file%201&name=a%26b.pdf'
        ], 'the file-download page URL is unchanged');
    }, { tags: ['unit'], timeout: 2000 });

    test('a synchronous tabs.create throw is acked as ok:false instead of escaping the listener', async function() {
        var l = await loadListener(function() { throw new TypeError('chrome.tabs is unavailable'); });
        var w = source(true);
        l.handler(download(w, 'd3'));
        await a3a3Flush();
        assert.strictEqual(w.posted.length, 1);
        assert.strictEqual(w.posted[0].msg.reqId, 'd3');
        assert.strictEqual(w.posted[0].msg.ok, false);
        assert.strictEqual(w.posted[0].msg.error, 'chrome.tabs is unavailable');
    }, { tags: ['unit'], timeout: 2000 });

    test('keeps the _isWidgetSource gate: a non-widget source gets no tab and no reply', async function() {
        var l = await loadListener(function() { return Promise.resolve({ id: 1 }); });
        var stranger = source(false);
        l.handler(download(stranger, 'd4'));
        l.handler({ source: source(true), data: { type: 'somethingElse', reqId: 'd5' } });
        await a3a3Flush();
        assert.deepStrictEqual(l.created, [], 'no tab is opened');
        assert.deepStrictEqual(stranger.posted, [], 'no reply to a non-widget source');
    }, { tags: ['unit'], timeout: 2000 });

    test('a reply to a torn-down widget does not throw', async function() {
        var l = await loadListener(function() { return Promise.resolve({ id: 2 }); });
        var gone = { isWidget: true, postMessage: function() { throw new Error('detached'); } };
        var unhandled = null;
        try {
            l.handler(download(gone, 'd6'));
            await a3a3Flush();
        } catch (e) { unhandled = e; }
        assert.strictEqual(unhandled, null);
        assert.strictEqual(l.created.length, 1);
    }, { tags: ['unit'], timeout: 2000 });
});

describe('A3A3-02 get_file download card shows the acked outcome', function() {
    // Slice the REAL card script expression out of get_file's _dlHtml builder and
    // evaluate it with the two escaped interpolations it references.
    async function cardScript() {
        var src = await loadFile('src/js/tools/040-file-store.js');
        var a0 = src.indexOf('var _dlHtml = ');
        var a = src.indexOf("'<script>' +", a0);
        var END = "'<\\/script>'";
        var b = src.indexOf(END, a);
        assert.ok(a0 >= 0 && a > a0 && b > a, 'card script anchors present in 040-file-store.js');
        var html = Function('_dlIdEsc', '_dlFnEsc', 'return ' + src.slice(a, b + END.length) + ';')('file_1', 'report.pdf');
        assert.ok(html.indexOf('<script>') === 0 && /<\/script>$/.test(html), 'sliced expression yields the script element');
        return html.slice('<script>'.length, html.length - '</script>'.length);
    }
    // Runs the card script against a fake button/window with manual timers.
    async function mountCard() {
        var text = await cardScript();
        var btn = { textContent: '\u2B07 Download', disabled: false };
        var listeners = [], timers = [], posted = [];
        var win = {
            addEventListener: function(t, fn) { if (t === 'message') listeners.push(fn); },
            removeEventListener: function(t, fn) { var i = listeners.indexOf(fn); if (t === 'message' && i >= 0) listeners.splice(i, 1); },
            parent: { postMessage: function(m, o) { posted.push({ msg: m, origin: o }); } }
        };
        var doc = { querySelector: function(sel) { return sel === '.dl-b' ? btn : null; } };
        function fakeSetTimeout(fn, ms) { timers.push({ fn: fn, ms: ms || 0, cleared: false, ran: false }); return timers.length; }
        function fakeClearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; }
        var api = Function('window', 'document', 'setTimeout', 'clearTimeout',
            text + '\nreturn { doDownload: doDownload };')(win, doc, fakeSetTimeout, fakeClearTimeout);
        return {
            btn: btn, posted: posted, listeners: listeners,
            click: function() { api.doDownload(); },
            lastReqId: function() { return posted.length ? posted[posted.length - 1].msg.reqId : undefined; },
            ack: function(data) { listeners.slice().forEach(function(fn) { fn({ data: data, source: win.parent }); }); },
            // Fires every pending, uncleared timer due within ms of the click.
            advance: function(ms) { timers.forEach(function(t) { if (!t.cleared && !t.ran && t.ms <= ms) { t.ran = true; t.fn(); } }); }
        };
    }

    test('click posts widgetDownload with a reqId and stays "Opening..." (no unconditional "Sent")', async function() {
        var c = await mountCard();
        c.click();
        assert.strictEqual(c.btn.textContent, 'Opening...');
        assert.strictEqual(c.btn.disabled, true);
        assert.strictEqual(c.posted.length, 1);
        var m = c.posted[0].msg;
        assert.strictEqual(m.type, 'widgetDownload');
        assert.strictEqual(m.fileId, 'file_1');
        assert.strictEqual(m.name, 'report.pdf');
        assert.strictEqual(typeof m.reqId, 'string', 'the request carries a reqId for the ack');
        assert.ok(m.reqId.length > 0);
        c.advance(4999);
        assert.strictEqual(c.btn.textContent, 'Opening...', 'nothing claims success before an ack arrives');
        assert.strictEqual(c.btn.disabled, true);
    }, { tags: ['unit'], timeout: 2000 });

    test('an ok:false ack shows the failure and re-enables the button; a retry can succeed', async function() {
        var c = await mountCard();
        c.click();
        c.ack({ type: 'widgetDownloadResult', reqId: 'not-mine', ok: true });
        c.ack({ type: 'widgetToolResult', reqId: c.lastReqId(), ok: true });
        assert.strictEqual(c.btn.textContent, 'Opening...', 'foreign or mismatched messages are ignored');
        c.ack({ type: 'widgetDownloadResult', reqId: c.lastReqId(), ok: false, error: 'No tab for you' });
        assert.strictEqual(c.btn.textContent, '\u26A0 Failed, retry');
        assert.strictEqual(c.btn.disabled, false, 'the user can retry');
        assert.strictEqual(c.listeners.length, 0, 'the ack listener is removed once settled');
        c.advance(5000);
        assert.strictEqual(c.btn.textContent, '\u26A0 Failed, retry', 'the 5 s fallback was cancelled by the ack');

        c.click();
        assert.strictEqual(c.posted.length, 2);
        assert.strictEqual(c.btn.disabled, true);
        c.ack({ type: 'widgetDownloadResult', reqId: c.lastReqId(), ok: true });
        assert.strictEqual(c.btn.textContent, '\u2705 Opened');
    }, { tags: ['unit'], timeout: 2000 });

    test('an ok:true ack shows "Opened" and cancels the fallback', async function() {
        var c = await mountCard();
        c.click();
        c.ack({ type: 'widgetDownloadResult', reqId: c.lastReqId(), ok: true });
        assert.strictEqual(c.btn.textContent, '\u2705 Opened');
        c.advance(5000);
        assert.strictEqual(c.btn.textContent, '\u2705 Opened', 'the fallback does not overwrite a real result');
    }, { tags: ['unit'], timeout: 2000 });

    test('no ack within 5 s restores the Download button; a late ack is ignored', async function() {
        var c = await mountCard();
        c.click();
        c.advance(5000);
        assert.strictEqual(c.btn.textContent, '\u2B07 Download');
        assert.strictEqual(c.btn.disabled, false);
        assert.strictEqual(c.listeners.length, 0);
        c.ack({ type: 'widgetDownloadResult', reqId: c.lastReqId(), ok: true });
        assert.strictEqual(c.btn.textContent, '\u2B07 Download', 'a late ack does not change the restored button');
    }, { tags: ['unit'], timeout: 2000 });
});
