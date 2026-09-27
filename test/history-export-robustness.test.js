// S0B2-07 — ui/050-history-view.js export robustness.
// downloadChatHistory must rehydrate ONE chat at a time (no Promise.all), build
// the Blob from one part per chat (no single giant string), keep the old JSON
// shape, count chats still evicted after ensureChatPayloads as incomplete, and
// turn any throw into an error snackbar (never an unhandled rejection or a
// false success). exportChatFromHistory gets the same try/catch.
// Run: run_tests { files: ['test/history-export-robustness.test.js'] }
describe('S0B2-07 history export robustness (ui/050-history-view.js)', function() {
    var SRC = 'src/js/ui/050-history-view.js';
    async function setup(chatsObj, opts) {
        opts = opts || {};
        var log = [], snacks = [], blobs = [], st = { active: 0, max: 0, calls: [] };
        function FakeBlob(parts, o) { this.parts = parts.slice(); this.type = o && o.type; blobs.push(this); }
        var body = { appendChild: function(el) { log.push('append'); el.parentNode = body; }, removeChild: function(el) { log.push('remove'); el.parentNode = null; } };
        var doc = { body: body, createElement: function(tag) { var el = { tagName: String(tag).toUpperCase(), click: function() { log.push('click'); } }; return el; } };
        var url = { createObjectURL: function(b) { log.push('create'); return 'blob:test/' + blobs.indexOf(b); }, revokeObjectURL: function(u) { log.push('revoke:' + u); } };
        async function ensureChatPayloads(id) {
            st.calls.push(id); st.active++; if (st.active > st.max) st.max = st.active;
            for (var k = 0; k < 3; k++) await Promise.resolve(); // microtask yields
            st.active--;
            if (opts.onEnsure) opts.onEnsure(id, chatsObj);
            else if (chatsObj[id]) delete chatsObj[id]._payloadsEvicted; // full restore
        }
        var m = await loadModules([SRC], { lenient: true, globals: { chats: chatsObj, ensureChatPayloads: ensureChatPayloads,
            showSnackbar: function(msg, type) { snacks.push([msg, type]); }, document: doc, Blob: FakeBlob, URL: url } });
        assert.strictEqual(typeof m.downloadChatHistory, 'function');
        assert.strictEqual(typeof m.exportChatFromHistory, 'function');
        return { m: m, log: log, snacks: snacks, blobs: blobs, st: st };
    }
    function three() {
        return {
            a: { title: 'Alpha', messages: [{ role: 'user', content: 'hi' }], createdAt: 1, updatedAt: 2, model: 'm1', totalCost: 0.5, pinned: true, _payloadsEvicted: true },
            b: { messages: [{ role: 'assistant', content: [{ type: 'image', source: { data: 'QUJD' } }] }], createdAt: 3, updatedAt: 4 },
            c: { title: 'Gamma', createdAt: 5, updatedAt: 6, model: 'm2', totalCost: 0, pinned: false }
        };
    }
    // The pre-fix export object (JSON round-trip drops undefined fields exactly like the old stringify).
    function oldShape(chatsObj, exportedAt) {
        var out = { exportedAt: exportedAt, totalChats: Object.keys(chatsObj).length, chats: {} };
        Object.keys(chatsObj).forEach(function(id) {
            var c = chatsObj[id];
            out.chats[id] = { title: c.title || 'Untitled Chat', messages: c.messages || [], createdAt: c.createdAt, updatedAt: c.updatedAt, model: c.model, totalCost: c.totalCost, pinned: c.pinned };
        });
        return JSON.parse(JSON.stringify(out));
    }

    test('downloadChatHistory hydrates chats one at a time and writes one Blob part per chat', async function() {
        var s = await setup(three());
        await s.m.downloadChatHistory();
        assert.deepStrictEqual(s.st.calls, ['a', 'b', 'c'], 'every chat rehydrated, in order');
        assert.strictEqual(s.st.max, 1, 'max concurrent ensureChatPayloads calls must be 1 (was Promise.all)');
        assert.strictEqual(s.blobs.length, 1);
        assert.strictEqual(s.blobs[0].type, 'application/json');
        assert.strictEqual(s.blobs[0].parts.length, 3 + 2, 'header + one part per chat + footer, not one giant string');
        var iClick = s.log.indexOf('click'), iRemove = s.log.indexOf('remove'), iRevoke = s.log.indexOf('revoke:blob:test/0');
        assert.ok(iClick >= 0 && iClick < iRemove && iRemove < iRevoke, 'click -> removeChild -> revokeObjectURL order kept: ' + s.log.join(','));
        assert.deepStrictEqual(s.snacks, [['Chat history exported (3 chats)', 'success']]);
    }, { tags: ['unit'] });

    test('downloadChatHistory output parses to the old export shape for 3 chats', async function() {
        var src = three(), s = await setup(src);
        await s.m.downloadChatHistory();
        var parsed = JSON.parse(s.blobs[0].parts.join(''));
        assert.ok(typeof parsed.exportedAt === 'string' && !isNaN(Date.parse(parsed.exportedAt)), 'exportedAt is an ISO date');
        assert.deepStrictEqual(Object.keys(parsed), ['exportedAt', 'totalChats', 'chats']);
        assert.deepStrictEqual(parsed, oldShape(src, parsed.exportedAt));
        assert.strictEqual(parsed.chats.b.title, 'Untitled Chat');
        assert.deepStrictEqual(parsed.chats.c.messages, []);
        assert.strictEqual(parsed.chats.a.pinned, true);
    }, { tags: ['unit'] });

    test('downloadChatHistory: a chat whose messages getter throws -> error snackbar, no success, promise resolves', async function() {
        var src = three();
        Object.defineProperty(src.b, 'messages', { enumerable: true, configurable: true, get: function() { throw new Error('boom'); } });
        var s = await setup(src), threw = null;
        try { await s.m.downloadChatHistory(); } catch (e) { threw = e; }
        assert.strictEqual(threw, null, 'must not reject (inline onclick -> unhandled rejection)');
        assert.deepStrictEqual(s.snacks, [['Chat history export failed: boom', 'error']]);
        assert.ok(!s.snacks.some(function(x) { return x[1] === 'success'; }), 'no false success');
        assert.strictEqual(s.blobs.length, 0, 'no partial download');
        assert.strictEqual(s.log.indexOf('click'), -1);
    }, { tags: ['unit'] });

    test('downloadChatHistory: a chat still evicted after ensureChatPayloads -> warning with "1 incomplete"', async function() {
        var src = three();
        src.b._payloadsEvicted = true;
        var s = await setup(src, { onEnsure: function(id, cs) { if (id !== 'b' && cs[id]) delete cs[id]._payloadsEvicted; } });
        await s.m.downloadChatHistory();
        assert.deepStrictEqual(s.snacks, [['Chat history exported (3 chats, 1 incomplete)', 'warning']]);
        assert.strictEqual(s.blobs.length, 1, 'the export is still written');
        assert.strictEqual(JSON.parse(s.blobs[0].parts.join('')).totalChats, 3);
    }, { tags: ['unit'] });

    test('downloadChatHistory: a chat deleted mid-export is skipped and totalChats matches the exported count', async function() {
        var src = three();
        var s = await setup(src, { onEnsure: function(id, cs) { if (id === 'b') delete cs.b; else if (cs[id]) delete cs[id]._payloadsEvicted; } });
        await s.m.downloadChatHistory();
        var parsed = JSON.parse(s.blobs[0].parts.join(''));
        assert.deepStrictEqual(Object.keys(parsed.chats), ['a', 'c']);
        assert.strictEqual(parsed.totalChats, 2);
        assert.deepStrictEqual(s.snacks, [['Chat history exported (2 chats)', 'success']]);
    }, { tags: ['unit'] });

    test('exportChatFromHistory: a throwing messages getter -> error snackbar and resolves; the happy path still exports', async function() {
        var src = three();
        Object.defineProperty(src.b, 'messages', { enumerable: true, configurable: true, get: function() { throw new Error('boom'); } });
        var s = await setup(src), threw = null;
        try { await s.m.exportChatFromHistory('b'); } catch (e) { threw = e; }
        assert.strictEqual(threw, null, 'must not reject');
        assert.deepStrictEqual(s.snacks, [['Chat export failed: boom', 'error']]);
        assert.strictEqual(s.blobs.length, 0);
        await s.m.exportChatFromHistory('a');
        assert.deepStrictEqual(s.snacks[1], ['Chat exported', 'success']);
        assert.strictEqual(JSON.parse(s.blobs[0].parts.join('')).title, 'Alpha');
        assert.ok(s.log.indexOf('click') < s.log.indexOf('remove') && s.log.indexOf('remove') < s.log.indexOf('revoke:blob:test/0'));
    }, { tags: ['unit'] });

    // A7B2-01: the single-chat export showed a green 'Chat exported' even when
    // rehydration left the chat evicted (stripped attachments) or threw.
    test('A7B2-01: exportChatFromHistory warns when the chat is still evicted after rehydrate', async function() {
        var s = await setup(three(), { onEnsure: function() {} }); // partial restore: 'a' keeps _payloadsEvicted
        await s.m.exportChatFromHistory('a');
        assert.deepStrictEqual(s.snacks, [['Chat exported (some attachments could not be restored)', 'warning']]);
        assert.strictEqual(s.blobs.length, 1, 'the export is still written');
        assert.strictEqual(JSON.parse(s.blobs[0].parts.join('')).title, 'Alpha');
    }, { tags: ['unit'] });

    test('A7B2-01: a rehydrate that throws also warns', async function() {
        var s = await setup(three(), { onEnsure: function() { throw new Error('idb down'); } });
        await s.m.exportChatFromHistory('c');
        assert.deepStrictEqual(s.snacks, [['Chat exported (some attachments could not be restored)', 'warning']]);
        assert.strictEqual(s.blobs.length, 1, 'the export is still written');
        assert.strictEqual(JSON.parse(s.blobs[0].parts.join('')).title, 'Gamma');
    }, { tags: ['unit'] });
});

// S0B-15 — ui/210-chat-menus.js downloadChat: any throw (non-string title,
// serialisation, Blob/URL) is an error snackbar, never an unhandled rejection or a
// false success; a chat still evicted after rehydrate (or a rehydrate that throws)
// gives a warning; the export drops transient '_' fields.
describe('S0B-15 downloadChat (ui/210-chat-menus.js)', function() {
    async function setup(chatsObj, opts) {
        opts = opts || {};
        var log = [], snacks = [], blobs = [], anchors = [];
        function FakeBlob(parts, o) { this.parts = parts.slice(); this.type = o && o.type; blobs.push(this); }
        var body = { appendChild: function() { log.push('append'); }, removeChild: function() { log.push('remove'); } };
        var doc = { body: body, addEventListener: function() {}, createElement: function(tag) { var el = { tagName: String(tag).toUpperCase(), click: function() { log.push('click'); } }; anchors.push(el); return el; } };
        var url = { createObjectURL: function() { log.push('create'); return 'blob:test'; }, revokeObjectURL: function(u) { log.push('revoke:' + u); } };
        async function ensureChatPayloads(id) { if (opts.onEnsure) return opts.onEnsure(id); delete chatsObj[id]._payloadsEvicted; }
        // Like stripTransientChatFieldsForPut: drops '_' keys except the persisted _payloadsEvicted.
        function strip(rec) { var o = {}; Object.keys(rec).forEach(function(k) { if (k.charAt(0) !== '_' || k === '_payloadsEvicted') o[k] = rec[k]; }); return o; }
        var m = await loadModules(['src/js/ui/210-chat-menus.js'], { globals: { chats: chatsObj, ensureChatPayloads: ensureChatPayloads, stripTransientChatFieldsForPut: strip,
            showSnackbar: function(msg, type) { snacks.push([msg, type]); }, document: doc, Blob: FakeBlob, URL: url } });
        assert.strictEqual(typeof m.downloadChat, 'function');
        return { m: m, log: log, snacks: snacks, anchors: anchors, exported: function() { return JSON.parse(blobs[0].parts.join('')); } };
    }

    test('S0B-15 downloadChat: title:null downloads chat_chat_*.json and resolves', async function() {
        var s = await setup({ c1: { id: 'c1', title: null, messages: [{ role: 'user', content: 'hi' }] } });
        await s.m.downloadChat('c1');
        assert.strictEqual(s.anchors.length, 1);
        assert.match(s.anchors[0].download, /^chat_chat_\d{4}-\d{2}-\d{2}\.json$/, 'was a TypeError on chat.title.replace');
        assert.deepStrictEqual(s.log, ['create', 'append', 'click', 'remove', 'revoke:blob:test']);
        assert.deepStrictEqual(s.snacks, [['Chat downloaded', 'success']]);
        assert.strictEqual(s.exported().exportType, 'single_chat');
        assert.deepStrictEqual(s.exported().chat.messages, [{ role: 'user', content: 'hi' }]);
    }, { tags: ['unit'] });

    test('S0B-15 downloadChat: a throwing messages getter gives an error snackbar and no success', async function() {
        var chat = { id: 'c1', title: 'T' };
        Object.defineProperty(chat, 'messages', { enumerable: true, get: function() { throw new Error('getter boom'); } });
        var s = await setup({ c1: chat });
        await s.m.downloadChat('c1');
        assert.deepStrictEqual(s.snacks, [['Download failed: getter boom', 'error']]);
        assert.strictEqual(s.anchors.length, 0, 'no download link');
    }, { tags: ['unit'] });

    test('S0B-15 downloadChat: still evicted after rehydrate gives a warning', async function() {
        var s = await setup({ c1: { id: 'c1', title: 'Pics', messages: [], _payloadsEvicted: true } }, { onEnsure: function() {} });
        await s.m.downloadChat('c1');
        assert.deepStrictEqual(s.snacks, [['Chat downloaded (some attachments could not be restored)', 'warning']]);
        assert.strictEqual(s.anchors.length, 1, 'the partial export is still downloaded');
        assert.strictEqual(s.exported().chat._payloadsEvicted, true, 'the file says it is incomplete');
        var r = await setup({ c2: { id: 'c2', title: 'X', messages: [] } }, { onEnsure: async function() { throw new Error('idb down'); } });
        await r.m.downloadChat('c2');
        assert.deepStrictEqual(r.snacks, [['Chat downloaded (some attachments could not be restored)', 'warning']]);
    }, { tags: ['unit'] });

    test('S0B-15 downloadChat: transient _ fields are not exported', async function() {
        var chatsObj = { c1: { id: 'c1', title: 'T', messages: [], _streaming: true, _scrollTop: 5 } };
        var s = await setup(chatsObj);
        await s.m.downloadChat('c1');
        var c = s.exported().chat;
        assert.strictEqual(c.id, 'c1');
        assert.ok(!('_streaming' in c) && !('_scrollTop' in c), 'transient fields dropped: ' + Object.keys(c).join(','));
        assert.strictEqual(chatsObj.c1._streaming, true, 'the live chat is not mutated');
        assert.deepStrictEqual(s.snacks, [['Chat downloaded', 'success']]);
    }, { tags: ['unit'] });
});

// TB-8 / TB-9 - ui/090-version-history.js combined XML export (downloadChangesXml).
// TB-8: an HTTP 200 is not enough. Only an <unload>/<record_update>/<xml> root
// with a record inside is exported; a login page or the empty <xml/> of a
// missing record goes to skipped (getLatestRecordXml returns null for it).
// TB-9: sys_attachment rows are left out (their bytes live in sys_attachment_doc
// chunks, which are not exported) and are listed as not exported.
describe('TB-8/TB-9 version-history XML export (ui/090-version-history.js)', function() {
    var SRC = 'src/js/ui/090-version-history.js';
    var SI = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', INC = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    var ATT = 'aaaabbbbccccddddeeeeffff00001111', VER = '11112222333344445555666677778888';
    var DECL = '<?xml version="1.0" encoding="UTF-8"?>';
    var PAYLOAD = DECL + '<record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><name>ZZ Include</name></sys_script_include></record_update>';
    var INC_XML = DECL + '<xml><incident><number>INC0010001</number></incident></xml>';
    var ATT_XML = DECL + '<xml><sys_attachment><file_name>logo.png</file_name></sys_attachment></xml>';
    var LOGIN = '<!DOCTYPE html><html><head><title>Log in | ServiceNow</title></head><body><form id="loginPage" action="login.do"></form></body></html>';
    var EMPTY = DECL + '<xml/>';
    var SCRIPT = { chatId: 'c1', table: 'sys_script_include', sysId: SI, displayName: 'ZZ Include', action: 'UPDATE', afterVersion: VER, timestamp: 3 };
    var INCIDENT = { chatId: 'c1', table: 'incident', sysId: INC, displayName: 'INC0010001', action: 'UPDATE', afterVersion: null, timestamp: 2 };
    var ATTACHMENT = { chatId: 'c1', table: 'sys_attachment', sysId: ATT, displayName: 'logo.png', action: 'POST', beforeVersion: null, afterVersion: null, timestamp: 1 };
    // doXml: { <table>: text } is answered with HTTP 200 by <table>.do?XML (anything else: 404).
    async function setup(history, doXml) {
        var t = { fetched: [], snacks: [], blobs: [], clicks: 0 };
        function resp(ok, body) { return { ok: ok, status: ok ? 200 : 404, json: async function() { return body; }, text: async function() { return String(body); } }; }
        var doc = { body: { appendChild: function() {}, removeChild: function() {} },
            createElement: function(tag) { return { tagName: String(tag).toUpperCase(), click: function() { t.clicks++; } }; } };
        t.m = await loadModules([SRC], { lenient: true, globals: {
            window: { sessionToken: 'tok' }, document: doc,
            fetch: async function(url) {
                t.fetched.push(url);
                if (url.indexOf('/api/now/table/sys_update_version/' + VER) === 0) return resp(true, { result: { payload: PAYLOAD } });
                var hit = /^\/([a-z_]+)\.do\?XML&sys_id=/.exec(url);
                if (hit && Object.prototype.hasOwnProperty.call(doXml || {}, hit[1])) return resp(true, doXml[hit[1]]);
                return resp(false, 'Not found');
            },
            Blob: function(parts) { t.blobs.push(parts.join('')); },
            URL: { createObjectURL: function() { return 'blob:zz'; }, revokeObjectURL: function() {} },
            showSnackbar: function(msg, type) { t.snacks.push([msg, type]); }, showSpinner: function() {}, hideSpinner: function() {},
            chats: {}, currentChatId: 'c1', versionHistory: history,
            getRecordVersion: async function() { return null; },
            _recValidTable: /^[a-zA-Z_][a-zA-Z0-9_]*$/, _recValidSysId: /^[0-9a-fA-F]{32}$/ // as in core/150-record-helpers.js
        } });
        assert.strictEqual(typeof t.m.downloadChangesXml, 'function');
        return t;
    }

    test('TB-8 getRecordXmlBody: only a record inside an unload/record_update/xml root', async function() {
        var m = (await setup([], {})).m;
        assert.strictEqual(m.getRecordXmlBody(PAYLOAD), '<sys_script_include action="INSERT_OR_UPDATE"><name>ZZ Include</name></sys_script_include>');
        assert.strictEqual(m.getRecordXmlBody(INC_XML), '<incident><number>INC0010001</number></incident>');
        assert.strictEqual(m.getRecordXmlBody('<unload unload_date="2026-09-25 10:00:00"><sys_script action="DELETE"/></unload>'), '<sys_script action="DELETE"/>');
        [LOGIN, EMPTY, '<xml/>', DECL + '<xml></xml>', '<xml>\n  </xml>', '<record_update table="x"></record_update>', 'Not found', '', null, undefined, '<incident><number>1</number></incident>']
            .forEach(function(x) { assert.strictEqual(m.getRecordXmlBody(x), null, 'not a record export: ' + String(x).slice(0, 40)); });
    }, { tags: ['unit'] });

    test('TB-8 a 200 login page from .do?XML goes to skipped, not into the export', async function() {
        var t = await setup([SCRIPT, INCIDENT], { incident: LOGIN });
        assert.strictEqual(await t.m.getLatestRecordXml('incident', INC), null, 'a login page is not the record XML');
        await t.m.downloadChangesXml();
        assert.strictEqual(t.clicks, 1);
        assert.strictEqual(t.blobs.length, 1);
        assert.match(t.blobs[0], /<sys_script_include\b[^>]*>[\s\S]*<\/sys_script_include>/);
        assert.ok(!/<html|<!DOCTYPE|loginPage/i.test(t.blobs[0]), 'the login page is not exported: ' + t.blobs[0]);
        assert.deepStrictEqual(t.snacks, [['Exported 1 of 2 records (not exported: INC0010001)', 'warning']]);
    }, { tags: ['unit'] });

    test('TB-8 an empty <xml/> export goes to skipped; no file when no record is left', async function() {
        var t = await setup([SCRIPT, INCIDENT], { incident: EMPTY });
        assert.strictEqual(await t.m.getLatestRecordXml('incident', INC), null, 'an empty <xml/> is not the record XML');
        await t.m.downloadChangesXml();
        assert.strictEqual(t.clicks, 1);
        assert.ok(t.blobs[0].indexOf('<xml') < 0, 'no <xml/> in the combined export: ' + t.blobs[0]);
        assert.deepStrictEqual(t.snacks, [['Exported 1 of 2 records (not exported: INC0010001)', 'warning']]);
        var only = await setup([INCIDENT], { incident: LOGIN });
        await only.m.downloadChangesXml();
        assert.strictEqual(only.clicks, 0, 'no file for a login page alone');
        assert.strictEqual(only.blobs.length, 0);
        assert.deepStrictEqual(only.snacks, [['Could not retrieve version data for any files (not exported: INC0010001)', 'error']]);
    }, { tags: ['unit'] });

    test('TB-8 buildUpdateSetXml adds nothing for an entry with no record', async function() {
        var m = (await setup([], {})).m;
        var out = m.buildUpdateSetXml([EMPTY, PAYLOAD, LOGIN]);
        assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<unload unload_date="[^"]+">\n<sys_script_include action="INSERT_OR_UPDATE"><name>ZZ Include<\/name><\/sys_script_include>\n<\/unload>$/);
    }, { tags: ['unit'] });

    test('TB-9 sys_attachment rows are not exported and are listed as not exported', async function() {
        var t = await setup([SCRIPT, INCIDENT, ATTACHMENT], { incident: INC_XML, sys_attachment: ATT_XML });
        await t.m.downloadChangesXml();
        assert.strictEqual(t.clicks, 1);
        assert.match(t.blobs[0], /<sys_script_include\b/);
        assert.match(t.blobs[0], /<incident><number>INC0010001<\/number><\/incident>/, 'control: a real .do?XML record is still exported');
        assert.ok(t.blobs[0].indexOf('sys_attachment') < 0 && t.blobs[0].indexOf('logo.png') < 0, 'the attachment row is not in the export');
        assert.ok(!t.fetched.some(function(u) { return u.indexOf('sys_attachment') >= 0; }), 'the attachment is not even fetched: ' + t.fetched.join(' '));
        assert.deepStrictEqual(t.snacks, [['Exported 2 of 3 records (not exported: logo.png (attachment))', 'warning']]);
        var only = await setup([ATTACHMENT], { sys_attachment: ATT_XML });
        await only.m.downloadChangesXml();
        assert.strictEqual(only.clicks, 0, 'an attachment alone downloads nothing');
        assert.deepStrictEqual(only.snacks, [['Could not retrieve version data for any files (not exported: logo.png (attachment))', 'error']]);
    }, { tags: ['unit'] });
});
