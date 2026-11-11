// PR #1187 — records mutated on a NON-active instance are tracked with
// `instanceUrl`, and every sidebar/diff action for such an entry must go to
// THAT instance (absolute URL + its token), refuse without a token, and never
// mix records from different instances. Behavioural: real modules, fake fetch.

var EX = await runFile('test/extract.js', { i18n: false });
var ACTIVE = 'https://active.service-now.com', OTHER = 'https://other.service-now.com';
var SID = 'a'.repeat(32), VB = 'b'.repeat(32), VA = 'c'.repeat(32), VO = 'd'.repeat(32), VO2 = 'e'.repeat(32);
var FILES = ['src/js/core/150-record-helpers.js', 'src/js/ui/090-version-history.js', 'src/js/ui/110-version-sidebar.js'];
var PAYLOAD = '<?xml version="1.0"?><record_update table="sys_script"><sys_script><name>x</name></sys_script></record_update>';

async function setup(history, tokens) {
    var s = { calls: [], snacks: [], history: history || [] };
    s.platform = { instanceUrl: ACTIVE, getSessionToken: function() { return 'ACTIVE_TOK'; },
        getTokenForInstance: async function(u) { return (tokens || {})[u] || ''; } };
    function resp(status, body) { return { ok: status >= 200 && status < 300, status: status, json: async function() { return body; }, text: async function() { return typeof body === 'string' ? body : JSON.stringify(body); } }; }
    s.chats = { c1: { messages: [], versionHistory: s.history } };
    s.m = await loadModules(FILES, { lenient: true, globals: {
        Platform: s.platform,
        window: { sessionToken: 'ACTIVE_TOK' },
        FormData: function() { this.append = function() {}; }, Blob: function() {},
        fetch: async function(url, o) {
            o = o || {};
            s.calls.push({ url: url, method: o.method || 'GET', token: o.headers && o.headers['X-UserToken'], credentials: o.credentials });
            if (/sysparm_fields=sys_scope/.test(url)) return resp(200, { result: { sys_scope: { value: 'global' } } });
            if (/sys_update_version\/[0-9a-f]{32}\?sysparm_fields=payload/.test(url)) return resp(200, { result: { payload: PAYLOAD } });
            if (/sys_upload\.do/.test(url)) return resp(200, 'outputmsg_success');
            if (o.method === 'DELETE') return resp(204, {});
            return resp(404, {});
        },
        showSnackbar: function(msg, type) { s.snacks.push([msg, type]); }, showSpinner: function() {}, hideSpinner: function() {},
        showConfirmModal: async function() { return true; }, escapeHtml: function(x) { return String(x); },
        chats: s.chats, currentChatId: 'c1', versionHistory: s.history,
        saveVersionHistory: function() {}, renderVersionSidebar: function() {}, renderMessages: function() {},
        updateVersionSidebarVisibility: function() {}, saveChatsToStorage: function() {}, console: console
    } });
    return s;
}
function entry(o) { return Object.assign({ chatId: 'c1', table: 'sys_script', sysId: SID, displayName: 'BR', action: 'PATCH', timestamp: 1, messageIndex: 0 }, o); }
function hosts(s) { return s.calls.map(function(c) { return c.url; }); }

describe('sidebar actions target the entry instance', function() {
    test('Delete for an OTHER-instance entry hits that instance with its token', async function() {
        var s = await setup([entry({ action: 'POST', instanceUrl: OTHER }), entry({ action: 'POST' })], { 'https://other.service-now.com': 'OTHER_TOK' });
        await s.m.deleteNewRecordFromSidebar('sys_script', SID, 'BR', OTHER);
        var del = s.calls.filter(function(c) { return c.method === 'DELETE'; });
        assert.strictEqual(del.length, 1, JSON.stringify(s.calls));
        assert.strictEqual(del[0].url, OTHER + '/api/now/table/sys_script/' + SID + '?sysparm_record_scope=global');
        assert.strictEqual(del[0].token, 'OTHER_TOK');
        assert.strictEqual(del[0].credentials, 'include');
        s.calls.forEach(function(c) { assert.strictEqual(c.url.indexOf(OTHER), 0, 'never the active instance: ' + c.url); });
        assert.strictEqual(s.history[0].invalidated, true, 'other-instance entry invalidated');
        assert.ok(!s.history[1].invalidated, 'same sys_id on the active instance untouched');
        var ud = s.history.filter(function(v) { return v.action === 'USER_DELETE'; });
        assert.strictEqual(ud.length, 1);
        assert.strictEqual(ud[0].instanceUrl, OTHER);
    }, { tags: ['unit'], timeout: 3000 });

    test('Revert for an OTHER-instance entry fetches + imports on that instance', async function() {
        var s = await setup([entry({ instanceUrl: OTHER, beforeVersion: VB, afterVersion: VO })], { 'https://other.service-now.com': 'OTHER_TOK' });
        await s.m.revertToVersion(VB, 0, 'before');
        var urls = hosts(s);
        assert.ok(urls.indexOf(OTHER + '/api/now/table/sys_update_version/' + VB + '?sysparm_fields=payload') >= 0, urls.join('\n'));
        var up = s.calls.filter(function(c) { return /sys_upload\.do/.test(c.url); });
        assert.strictEqual(up.length, 1, urls.join('\n') + ' | ' + JSON.stringify(s.snacks));
        assert.strictEqual(up[0].url, OTHER + '/sys_upload.do?sysparm_record_scope=global');
        assert.strictEqual(up[0].token, 'OTHER_TOK');
        s.calls.forEach(function(c) { assert.strictEqual(c.url.indexOf(OTHER), 0, c.url); assert.strictEqual(c.token, 'OTHER_TOK'); });
        var rev = s.history.filter(function(v) { return v.action === 'REVERT'; });
        assert.strictEqual(rev.length, 1);
        assert.strictEqual(rev[0].instanceUrl, OTHER);
    }, { tags: ['unit'], timeout: 3000 });

    test('actions refuse (no request, error snackbar) when no token exists for the instance', async function() {
        var s = await setup([entry({ action: 'POST', instanceUrl: OTHER, beforeVersion: VB })], {});
        await s.m.deleteNewRecordFromSidebar('sys_script', SID, 'BR', OTHER);
        await s.m.revertToVersion(VB, 0, 'before');
        await s.m.downloadSingleFile('sys_script', SID, 'BR', OTHER);
        assert.strictEqual(s.calls.length, 0, 'no fetch at all: ' + hosts(s).join(', '));
        assert.strictEqual(s.snacks.length, 3);
        s.snacks.forEach(function(sn) { assert.strictEqual(sn[1], 'error'); assert.ok(sn[0].indexOf('other.service-now.com') >= 0, sn[0]); });
        assert.ok(!s.history[0].invalidated);
    }, { tags: ['unit'], timeout: 3000 });

    test('active-instance entries still use relative URLs + the session token', async function() {
        var s = await setup([entry({ action: 'POST' })], {});
        await s.m.deleteNewRecordFromSidebar('sys_script', SID, 'BR');
        var del = s.calls.filter(function(c) { return c.method === 'DELETE'; });
        assert.strictEqual(del.length, 1);
        assert.strictEqual(del[0].url, '/api/now/table/sys_script/' + SID + '?sysparm_record_scope=global');
        assert.strictEqual(del[0].token, 'ACTIVE_TOK');
    }, { tags: ['unit'], timeout: 3000 });
});

describe('record identity is instance-aware', function() {
    test('untagged and active-tagged entries merge into one sidebar row; other instance stays separate', async function() {
        var s = await setup([entry({}), entry({ instanceUrl: 'ACTIVE.service-now.com/' }), entry({ instanceUrl: ACTIVE + '/nav_to.do' }), entry({ instanceUrl: OTHER })], {});
        var files = s.m.getAllChangedFiles();
        assert.strictEqual(files.length, 2, JSON.stringify(files.map(function(f) { return f.instanceUrl; })));
        var act = files.filter(function(f) { return !f.instanceUrl; })[0], oth = files.filter(function(f) { return f.instanceUrl === OTHER; })[0];
        assert.strictEqual(act.changes.length, 3);
        assert.strictEqual(oth.changes.length, 1);
        assert.strictEqual(s.m.recordEntryKey({ table: 't', sysId: SID }), s.m.recordEntryKey({ table: 't', sysId: SID, instanceUrl: ACTIVE }));
        assert.notStrictEqual(s.m.recordEntryKey({ table: 't', sysId: SID }), s.m.recordEntryKey({ table: 't', sysId: SID, instanceUrl: OTHER }));
    }, { tags: ['unit'], timeout: 3000 });

    test('lookup/invalidate/remove helpers never mix records from different instances', async function() {
        var hist = [entry({ beforeVersion: VA, afterVersion: VA, timestamp: 1 }), entry({ instanceUrl: OTHER, beforeVersion: VB, afterVersion: VO, timestamp: 2 }),
            entry({ instanceUrl: OTHER, beforeVersion: VO, afterVersion: VO2, timestamp: 3 }),
            entry({ action: 'REVERT', afterVersion: VA }), entry({ action: 'REVERT', instanceUrl: OTHER, afterVersion: VB })];
        var s = await setup(hist, {});
        var m = s.m;
        assert.strictEqual(m.getFirstVersionForRecord('sys_script', SID), VA);
        assert.strictEqual(m.getFirstVersionForRecord('sys_script', SID, OTHER), VB);
        assert.strictEqual(m.getLatestAfterVersion('sys_script', SID), VA);
        assert.strictEqual(m.getLatestAfterVersion('sys_script', SID, OTHER), VO2);
        var ids = m.getVersionsForFile('sys_script', SID, OTHER).map(function(v) { return v.versionId; });
        assert.ok(ids.indexOf(VA) < 0 && ids.indexOf(VB) >= 0 && ids.indexOf(VO2) >= 0, ids.join(','));
        m.setRecordEntriesInvalidated('sys_script', SID, true, OTHER);
        assert.ok(!hist[0].invalidated, 'active entry untouched');
        assert.strictEqual(hist[1].invalidated, true);
        assert.strictEqual(hist[2].invalidated, true);
        m.removeRevertEntriesForRecord('sys_script', SID, OTHER);
        var reverts = s.chats.c1.versionHistory.filter(function(v) { return v.action === 'REVERT'; });
        assert.strictEqual(reverts.length, 1, 'only the OTHER revert removed');
        assert.ok(!reverts[0].instanceUrl);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('trackRecordMutation stamps a normalized instanceUrl', function() {
    test('other instance kept (normalized); active instance stored as its normalized origin', async function() {
        var h = await loadModules(['src/js/core/150-record-helpers.js'], { globals: { Platform: { instanceUrl: ACTIVE } } });
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var fx = EX.findFunction(src, 'trackRecordMutation', { includeAsync: false });   // code-mask cut (test/extract.js)
        var start = fx ? fx.start : -1;
        var end = fx ? fx.end + 1 : -1;   // + 1 keeps the trailing newline
        var chats = { c1: { versionHistory: [] } };
        var fn = new Function('chats', 'AgentEvents', 'saveChatsToStorage', 'recordInstanceKey', 'recordStoredInstanceUrl', src.slice(start, end) + '\nreturn trackRecordMutation;')(
            chats, { emit: function() {} }, function() {}, h.recordInstanceKey, h.recordStoredInstanceUrl);
        fn({ chatId: 'c1', table: 'incident', sysId: SID, action: 'PATCH', instanceUrl: 'OTHER.service-now.com/' });
        fn({ chatId: 'c1', table: 'incident', sysId: SID, action: 'PATCH', instanceUrl: ACTIVE + '/' });
        fn({ chatId: 'c1', table: 'incident', sysId: SID, action: 'PATCH' }); // active-instance write: no evt.instanceUrl
        assert.strictEqual(chats.c1.versionHistory[0].instanceUrl, OTHER);
        assert.strictEqual(chats.c1.versionHistory[1].instanceUrl, ACTIVE);
        assert.strictEqual(chats.c1.versionHistory[2].instanceUrl, ACTIVE);
        // still keyed as the active instance (merges with legacy untagged entries)
        assert.strictEqual(h.recordEntryKey(chats.c1.versionHistory[2]), h.recordEntryKey({ table: 'incident', sysId: SID }));
    }, { tags: ['unit'], timeout: 3000 });
});

describe('entries stored while instance A was active keep targeting A after switching to B', function() {
    var B = 'https://bravo.service-now.com';
    test('delete + revert go to A (absolute URL, A token); new entries keep A', async function() {
        var tok = {}; tok[ACTIVE] = 'A_TOK';
        var s = await setup([], tok);
        // stored while A is active (what trackRecordMutation does for an active write)
        var stored = s.m.recordStoredInstanceUrl(undefined);
        assert.strictEqual(stored, ACTIVE);
        s.history.push(entry({ action: 'POST', instanceUrl: stored, timestamp: 1 }));
        s.history.push(entry({ sysId: VA, instanceUrl: stored, beforeVersion: VB, afterVersion: VO, timestamp: 2 }));
        var activeTgt = await s.m.resolveRecordTarget(stored);
        assert.strictEqual(activeTgt.active, true, 'A while A is active');
        s.platform.instanceUrl = B; // user switches the active instance
        var tgt = await s.m.resolveRecordTarget(stored);
        assert.deepStrictEqual(tgt, { active: false, instanceUrl: ACTIVE, token: 'A_TOK' });
        var files = s.m.getAllChangedFiles();
        var f = files.filter(function(x) { return x.sysId === SID; })[0];
        assert.strictEqual(f.instanceUrl, ACTIVE, 'sidebar row carries A');
        await s.m.deleteNewRecordFromSidebar('sys_script', SID, 'BR', f.instanceUrl);
        var del = s.calls.filter(function(c) { return c.method === 'DELETE'; });
        assert.strictEqual(del.length, 1, JSON.stringify(s.calls));
        assert.strictEqual(del[0].url, ACTIVE + '/api/now/table/sys_script/' + SID + '?sysparm_record_scope=global');
        assert.strictEqual(del[0].token, 'A_TOK');
        await s.m.revertToVersion(VB, 1, 'before');
        var up = s.calls.filter(function(c) { return /sys_upload\.do/.test(c.url); });
        assert.strictEqual(up.length, 1, JSON.stringify(s.snacks));
        assert.strictEqual(up[0].url, ACTIVE + '/sys_upload.do?sysparm_record_scope=global');
        s.calls.forEach(function(c) { assert.strictEqual(c.url.indexOf(ACTIVE), 0, 'never B / relative: ' + c.url); assert.strictEqual(c.token, 'A_TOK'); });
        var added = s.history.filter(function(v) { return v.action === 'USER_DELETE' || v.action === 'REVERT'; });
        assert.strictEqual(added.length, 2);
        added.forEach(function(v) { assert.strictEqual(v.instanceUrl, ACTIVE); });
    }, { tags: ['unit'], timeout: 3000 });

    test('refused (no request) when A has no token after the switch; legacy untagged stays active', async function() {
        var s = await setup([], {});
        var stored = s.m.recordStoredInstanceUrl('');
        s.history.push(entry({ action: 'POST', instanceUrl: stored, beforeVersion: VB }));
        s.platform.instanceUrl = B;
        assert.strictEqual(await s.m.resolveRecordTarget(stored), null);
        await s.m.deleteNewRecordFromSidebar('sys_script', SID, 'BR', stored);
        await s.m.revertToVersion(VB, 0, 'before');
        assert.strictEqual(s.calls.length, 0, hosts(s).join(', '));
        assert.strictEqual(s.snacks.length, 2);
        s.snacks.forEach(function(sn) { assert.strictEqual(sn[1], 'error'); assert.ok(sn[0].indexOf('active.service-now.com') >= 0, sn[0]); });
        var legacy = await s.m.resolveRecordTarget(undefined);
        assert.strictEqual(legacy.active, true);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('sys_ui_page Open/Screenshot target the entry instance', function() {
    test('_uiPageUrl: relative for active/legacy, absolute origin for another instance', async function() {
        var h = await loadModules(['src/js/core/150-record-helpers.js'], { globals: { Platform: { instanceUrl: ACTIVE } } });
        var src = await loadFile('src/js/ui/270-iframe-panel.js');
        var fx = EX.findFunction(src, '_uiPageUrl', { includeAsync: false });   // code-mask cut (test/extract.js)
        var start = fx ? fx.start : -1;
        var end = fx ? fx.end + 1 : -1;   // + 1 keeps the trailing newline
        var fn = new Function('recordInstanceKey', src.slice(start, end) + '\nreturn _uiPageUrl;')(h.recordInstanceKey);
        assert.strictEqual(fn('my_page', ''), '/my_page.do');
        assert.strictEqual(fn('my_page', ACTIVE), '/my_page.do');
        assert.strictEqual(fn('my_page', 'OTHER.service-now.com/'), OTHER + '/my_page.do');
        assert.ok(/onclick="openUIPageInBrowser\(\\'' \+ jsDisplayName \+ '\\', \\'' \+ jsInst/.test(await loadFile('src/js/ui/120-ui-utils.js')), 'sidebar passes the entry instance');
    }, { tags: ['unit'], timeout: 3000 });
});
