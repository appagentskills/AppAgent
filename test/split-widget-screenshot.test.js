// take_screenshot target:'split_widget' must capture the split pane IN PLACE:
// captureVisibleTab of the page's own tab, cropped to the pane rect — never the
// widget path (temp tab via chrome.tabs.create / offscreen re-render / Platform).
describe('take_screenshot split_widget in-place capture', function() {
    function rect(l, t, r, b) { return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }; }

    async function load(opts) {
        opts = opts || {};
        var calls = { capture: [], draw: [], created: [], sent: [], widgetIframe: 0, getURL: 0, gridLabels: [] };
        function FakeImage() { this.naturalWidth = 800; this.naturalHeight = 1480; }
        Object.defineProperty(FakeImage.prototype, 'src', { set: function(v) { var self = this; if (v && self.onload) setTimeout(function() { self.onload(); }, 0); }, get: function() { return ''; } });
        var frame = { getBoundingClientRect: function() { return opts.frameRect || rect(600, 60, 1010, 800); }, dataset: { savedWidgetId: 'w_frame' } };
        var content = opts.contentRect ? { getBoundingClientRect: function() { return opts.contentRect; } } : null;
        var pane = {
            hidden: !!opts.hidden,
            dataset: { widgetId: 'w_split' },
            querySelector: function(sel) { return sel === '.split-widget-content' ? content : null; },
            getBoundingClientRect: function() { return rect(600, 0, 1000, 800); }
        };
        var doc = {
            visibilityState: opts.visibility || 'visible',
            body: { classList: { contains: function(c) { return !!opts.sidepanel && c === 'sidepanel-mode'; } } },
            getElementById: function(id) { return id === 'split-widget-pane' && !opts.noPane ? pane : null; },
            createElement: function(tag) {
                if (!opts.grid || tag !== 'canvas') throw new Error('createElement must not be needed');
                var ctx = { drawImage: function() {}, beginPath: function() {}, moveTo: function() {}, lineTo: function() {}, stroke: function() {},
                    fillRect: function() {}, fillText: function(t) { calls.gridLabels.push(t); }, measureText: function(t) { return { width: String(t).length * 6 }; } };
                return { width: 0, height: 0, getContext: function() { return ctx; }, toDataURL: function() { return 'data:image/png;base64,GRID'; } };
            }
        };
        function FakeCanvas(w, h) { this.width = w; this.height = h; }
        FakeCanvas.prototype.getContext = function() {
            return { drawImage: function() { calls.draw.push(Array.prototype.slice.call(arguments, 1)); } };
        };
        FakeCanvas.prototype.convertToBlob = async function() { return { cropped: [this.width, this.height] }; };
        var chromeStub = {
            runtime: { getURL: function(p) { calls.getURL++; return 'chrome-extension://x/' + p; } },
            tabs: {
                getCurrent: async function() { return opts.noTab ? undefined : { id: 9, windowId: 4, active: opts.inactive ? false : true }; },
                captureVisibleTab: async function(winId, o) { calls.capture.push([winId, o.format]); return 'data:image/png;base64,FULL'; },
                create: async function(o) { calls.created.push(o); return { id: 99 }; }
            }
        };
        var m = await loadModules(['src/js/tools/060-take-screenshot.js'], { globals: {
            document: doc,
            window: { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 2, addEventListener: function() {}, removeEventListener: function() {} },
            chrome: chromeStub,
            _splitViewPaneFrame: function() { return opts.noFrame ? null : frame; },
            createImageBitmap: async function() { return { width: 2000, height: 1600, close: function() {} }; },
            OffscreenCanvas: FakeCanvas,
            _b64DataUrlToBlob: function(s) { return { blob: s }; },
            _blobToBase64DataUrl: async function(b) { return 'data:image/png;base64,CROP' + b.cropped.join('x'); },
            fitScreenshotScale: function() { return 1; },
            compressBase64Image: async function(s) { return s; },
            newFileId: function() { return 'file_ss_1'; },
            Image: FakeImage,
            Platform: { sendBrowserAction: function(a) { calls.sent.push(a); return Promise.resolve({ error: 'must not be called' }); } },
            getWidgetIframe: function() { calls.widgetIframe++; return null; },
            getWidgetById: function() { return null; },
            dashboardWidgets: {},
            chats: {}, currentChatId: undefined
        } });
        return { m: m, calls: calls };
    }

    function assertNoWidgetPath(calls) {
        assert.deepStrictEqual(calls.created, [], 'no new tab opened');
        assert.strictEqual(calls.getURL, 0, 'no ?widget= deep link built');
        assert.deepStrictEqual(calls.sent, [], 'no Platform browser action');
        assert.strictEqual(calls.widgetIframe, 0, 'widget branch not entered');
    }

    test('crops the visible capture to the widget iframe area (clipped to the pane) x pixel ratio', async function() {
        var x = await load();
        var r = await x.m.executeTakeScreenshot({ target: 'split_widget', name: 'pane' }, {});
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(x.calls.capture, [[4, 'png']], 'captured own tab window once');
        assert.deepStrictEqual(x.calls.draw, [[1200, 120, 800, 1480, 0, 0, 800, 1480]], 'crop = iframe rect clipped to pane, x2');
        assert.strictEqual(r.dimensions, '800x1480');
        assert.strictEqual(r.widget_id, 'w_split');
        assert.strictEqual(r._screenshotMessage.base64, 'data:image/png;base64,CROP800x1480');
        assert.deepStrictEqual(r.crop, { x: 600, y: 60, width: 400, height: 740, pixel_ratio: 2, include_header: false });
        assertNoWidgetPath(x.calls);
    }, { tags: ['unit'], timeout: 5000 });

    test('widget crop clips to .split-widget-content, so a scrolled iframe never pulls in header pixels', async function() {
        // iframe scrolled 40px up under the header (top 20 < content top 60)
        var x = await load({ frameRect: rect(600, 20, 1000, 900), contentRect: rect(600, 60, 1000, 780) });
        var r = await x.m.executeTakeScreenshot({ target: 'split_widget', name: 'pane' }, {});
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.crop, { x: 600, y: 60, width: 400, height: 720, pixel_ratio: 2, include_header: false });
        assert.deepStrictEqual(x.calls.draw, [[1200, 120, 800, 1440, 0, 0, 800, 1440]]);
        assertNoWidgetPath(x.calls);
    }, { tags: ['unit'], timeout: 5000 });

    test('grid overlays labels in CSS px of the crop', async function() {
        var x = await load({ grid: true });
        var r = await x.m.executeTakeScreenshot({ target: 'split_widget', grid: true, name: 'pane' }, {});
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r._screenshotMessage.base64, 'data:image/png;base64,GRID');
        // crop is 400x740 CSS px (labels = widget-iframe CSS coords, not the
        // full page viewport) -> step 50: x 50..350, y 50..700
        var xs = [], ys = [];
        for (var v = 50; v < 400; v += 50) xs.push(String(v));
        for (v = 50; v < 740; v += 50) ys.push(String(v));
        assert.deepStrictEqual(x.calls.gridLabels, xs.concat(ys));
        assertNoWidgetPath(x.calls);
    }, { tags: ['unit'], timeout: 5000 });

    test('include_header crops to the whole pane', async function() {
        var x = await load();
        var r = await x.m.executeTakeScreenshot({ target: 'split_widget', include_header: true, name: 'pane' }, {});
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(x.calls.draw, [[1200, 0, 800, 1600, 0, 0, 800, 1600]]);
        assertNoWidgetPath(x.calls);
    }, { tags: ['unit'], timeout: 5000 });

    test('side panel, hidden page, inactive tab or closed pane -> "split pane not visible", nothing captured', async function() {
        var cases = [
            [{ sidepanel: true }, /side panel/],
            [{ noTab: true }, /side panel/],
            [{ visibility: 'hidden' }, /not in front/],
            [{ inactive: true }, /not the active tab/],
            [{ hidden: true }, /no widget is shown/],
            [{ noPane: true }, /no widget is shown/],
            [{ noFrame: true }, /no widget is shown/]
        ];
        for (var i = 0; i < cases.length; i++) {
            var x = await load(cases[i][0]);
            var r = await x.m.executeTakeScreenshot({ target: 'split_widget', name: 'pane' }, {});
            assert.strictEqual(r.success, false, JSON.stringify(cases[i][0]));
            assert.match(r.error, /^split pane not visible/);
            assert.match(r.error, cases[i][1]);
            assert.deepStrictEqual(x.calls.capture, [], 'no capture');
            assertNoWidgetPath(x.calls);
        }
    }, { tags: ['unit'], timeout: 5000 });

    test('target widget still goes through the widget path (unchanged)', async function() {
        var x = await load();
        var r = await x.m.executeTakeScreenshot({ target: 'widget', widget_id: 'w1', name: 'w' }, {});
        assert.strictEqual(r.success, false);
        assert.match(r.error, /Widget not found: w1/);
        assert.strictEqual(x.calls.widgetIframe, 1, 'getWidgetIframe used for target widget');
        assert.deepStrictEqual(x.calls.capture, []);
    }, { tags: ['unit'], timeout: 5000 });
});
