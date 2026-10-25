// iframe_tool navigate: `instance` is OPTIONAL and only used for relative urls.
// Real src/js/tools/010-iframe-tool.js + src/js/core/080-tools.js, fake chrome/Platform.
describe('iframe_tool navigate without a ServiceNow instance', function() {
    var EXT = 'chrome-extension://abc/';
    async function load(opts) {
        opts = opts || {};
        var created = [], updated = [], refreshes = 0;
        var platform = {
            instanceUrl: 'https://dev1.service-now.com',
            instances: opts.instances || [{ shortName: 'dev1', url: 'https://dev1.service-now.com' }],
            resolveInstanceUrl: function(n) {
                if (!n) return this.instanceUrl;
                if (n.startsWith('http')) return n.replace(/\/$/, '');
                if (n.indexOf('.') !== -1) return 'https://' + n;
                for (var i = 0; i < this.instances.length; i++) if (this.instances[i].shortName === n) return this.instances[i].url;
                return null;
            },
            refreshInstances: async function() { refreshes++; if (opts.afterRefresh) this.instances = opts.afterRefresh; return this.instances; },
            sendBrowserAction: function() { return Promise.resolve({ success: true }); }
        };
        var chromeStub = {
            runtime: { getURL: function(p) { return EXT + (p || ''); }, sendMessage: function() {} },
            tabs: {
                get: async function(id) { if (id !== 3) throw new Error('No tab'); return { id: 3, url: 'https://www.example.com/' }; },
                create: async function(o) { created.push(o.url); return { id: 42, url: o.url }; },
                update: async function(id, o) { updated.push([id, o.url]); return { id: id, url: o.url }; },
                onUpdated: { addListener: function() {}, removeListener: function() {} },
                onRemoved: { addListener: function() {}, removeListener: function() {} }
            }
        };
        var docStub = { body: { classList: { contains: function() { return false; } } }, getElementById: function() { return null; } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { lenient: true, globals: {
            chrome: chromeStub, Platform: platform, document: docStub, chats: {}, currentChatId: undefined
        } });
        return { m: m, created: created, updated: updated, refreshes: function() { return refreshes; } };
    }

    test('tab_id:"new" + absolute url works with no instance, and with an unknown one (warning, not error)', async function() {
        var x = await load();
        var r1 = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: 'https://shop.example.com/' }, {});
        assert.strictEqual(r1.success, true, JSON.stringify(r1));
        assert.strictEqual(r1.tab_id, 42);
        assert.strictEqual(r1.warning, undefined);
        var r2 = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: 'https://shop.example.com/', instance: 'shopsite' }, {});
        assert.strictEqual(r2.success, true, JSON.stringify(r2));
        assert.match(r2.warning, /Ignored instance "shopsite"/);
        assert.deepStrictEqual(x.created, ['https://shop.example.com/', 'https://shop.example.com/']);
        assert.strictEqual(x.refreshes(), 0, 'absolute url never needs a registry refresh');
        // existing non-SN tab
        var r3 = await x.m.executeIframeTool({ action: 'navigate', tab_id: 3, url: 'https://shop.example.com/x', instance: 'shopsite' }, {});
        assert.strictEqual(r3.success, true, JSON.stringify(r3));
        assert.deepStrictEqual(x.updated, [[3, 'https://shop.example.com/x']]);
    }, { tags: ['unit'], timeout: 5000 });

    test('short name resolves for relative urls, refreshing a stale registry once', async function() {
        var x = await load({ instances: [], afterRefresh: [{ shortName: 'dev428560', url: 'https://dev428560.service-now.com' }] });
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/incident_list.do', instance: 'dev428560' }, {});
        assert.strictEqual(r.success, true, JSON.stringify(r));
        assert.deepStrictEqual(x.created, ['https://dev428560.service-now.com/incident_list.do']);
        assert.strictEqual(x.refreshes(), 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('relative url with an unknown instance still errors clearly (no guessed base)', async function() {
        var x = await load();
        var r = await x.m.executeIframeTool({ action: 'navigate', tab_id: 'new', url: '/x.do', instance: 'nope' }, {});
        assert.strictEqual(r.success, false);
        assert.match(r.error, /Unknown instance "nope"/);
        assert.match(r.error, /dev1/, 'lists known short names');
        assert.deepStrictEqual(x.created, []);
    }, { tags: ['unit'], timeout: 5000 });

    test('iframe_tool schema: instance is optional and described as relative-url base only', async function() {
        var src = await loadFile('src/js/core/080-tools.js');
        var start = src.indexOf("name: 'iframe_tool'");
        var end = src.indexOf("name: '", start + 20);
        var block = src.slice(start, end);
        assert.ok(start > 0 && end > start);
        assert.match(block, /required: \['action'\]/);
        assert.ok(block.indexOf("required: ['action', 'instance']") === -1);
        assert.match(block, /instance: \{ type: 'string', description: 'Optional\./);
    }, { tags: ['unit'], timeout: 5000 });
});
