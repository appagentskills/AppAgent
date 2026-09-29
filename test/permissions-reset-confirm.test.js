// S8B-02: the Settings / permissions-dropdown "Reset to defaults" link (ui/040-tools-settings.js,
// ui/140-dropdowns.js -> ui/070-dashboard-ui.js resetAllPermissionsToDefaults) used to wipe every custom
// tool permission, the connected instance's tier and this session's grants in ONE click, with no way back.
// These tests evaluate the REAL function (cut out of the workspace source by brace matching, with the real
// escapeHtml) over in-memory permission maps and recorders for every storage / offscreen / UI effect, and
// prove that nothing is saved, pushed or replaced unless the user confirms a danger dialog that says what
// will be lost - and that Cancel writes nothing at all.
async function realDecl(path, name) {
    var src = await loadFile(path);
    var m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(src);
    assert.ok(m, name + ' found in ' + path);
    var a = m.index + 1;
    var b = src.indexOf('\n}\n', a);
    assert.ok(b > a, name + ' end found in ' + path);
    return src.slice(a, b + 2);
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// opts.host: connected instance host ('' = none); opts.confirm: what showConfirmModal returns
// (a boolean or a promise the test resolves itself).
async function makeReset(opts) {
    opts = opts || {};
    var decl = await realDecl('src/js/ui/070-dashboard-ui.js', 'resetAllPermissionsToDefaults');
    var escDecl = await realDecl('src/js/ui/180-search.js', 'escapeHtml');
    // resetAllPermissionsToDefaults calls t(): the fixture gets the REAL i18n core first
    // (no catalog set = English identity, like the harness auto-include in test/harness.js),
    // so the file passes when it runs alone, not only after a test that leaked a global t().
    var i18nCore = await loadFile('src/js/core/025-i18n.js');
    assert.ok(typeof i18nCore === 'string' && i18nCore.indexOf('function t(') >= 0, 'missing i18n core source');
    var host = opts.host === undefined ? 'dev1.service-now.com' : opts.host;
    var rec = { saveTool: 0, saveInst: 0, push: [], render: 0, snack: [], confirm: [] };
    var initial = {
        toolPermissions: { r: 'deny', w: 'allow', web_fetch: 'allow', my_custom_tool: 'deny' },
        instancePermissions: { 'other.service-now.com': { tier: 'full', tools: { iw: 'allow' } } },
        sessionPermissions: { chat_1: { w: 'allow' }, chat_2: { web_fetch: 'allow' } }
    };
    if (host) initial.instancePermissions[host] = { tier: 'autonomous', tools: { ir: 'deny', iw: 'allow' } };
    var stubs = {
        init: clone(initial),
        GLOBAL_READ_KEYS: ['r'], GLOBAL_WRITE_KEYS: ['web_fetch', 'w'],
        INSTANCE_READ_KEYS: ['ir'], INSTANCE_WRITE_KEYS: ['iw'],
        saveToolPermissions: function() { rec.saveTool++; },
        saveInstancePermissions: function() { rec.saveInst++; },
        pushPermissionsToOffscreen: function(p) { rec.push.push(clone(p)); },
        renderToolPermissions: function() { rec.render++; },
        renderSettingsToolPermissions: function() {},
        updateSnStatus: function() {},
        showSnackbar: function(msg, type) { rec.snack.push([msg, type]); },
        getConnectedInstanceHost: function() { return host; },
        showConfirmModal: function(title, message, variant) {
            rec.confirm.push({ title: title, message: message, variant: variant });
            return opts.confirm;
        }
    };
    var body =
        'var toolPermissions = stubs.init.toolPermissions, instancePermissions = stubs.init.instancePermissions,\n' +
        '    sessionPermissions = stubs.init.sessionPermissions;\n' +
        'var GLOBAL_READ_KEYS = stubs.GLOBAL_READ_KEYS, GLOBAL_WRITE_KEYS = stubs.GLOBAL_WRITE_KEYS,\n' +
        '    INSTANCE_READ_KEYS = stubs.INSTANCE_READ_KEYS, INSTANCE_WRITE_KEYS = stubs.INSTANCE_WRITE_KEYS;\n' +
        'var saveToolPermissions = stubs.saveToolPermissions, saveInstancePermissions = stubs.saveInstancePermissions,\n' +
        '    pushPermissionsToOffscreen = stubs.pushPermissionsToOffscreen, renderToolPermissions = stubs.renderToolPermissions,\n' +
        '    renderSettingsToolPermissions = stubs.renderSettingsToolPermissions, updateSnStatus = stubs.updateSnStatus,\n' +
        '    showSnackbar = stubs.showSnackbar, getConnectedInstanceHost = stubs.getConnectedInstanceHost,\n' +
        '    showConfirmModal = stubs.showConfirmModal;\n' +
        i18nCore + '\n' + escDecl + '\n' + decl + '\n' +
        'return { run: resetAllPermissionsToDefaults, state: function() { return { toolPermissions: toolPermissions,\n' +
        '    instancePermissions: instancePermissions, sessionPermissions: sessionPermissions }; } };';
    var api = new Function('stubs', body)(stubs);
    return { run: api.run, state: api.state, rec: rec, initial: initial, host: host };
}

function assertNothingWritten(h, label) {
    assert.strictEqual(h.rec.saveTool, 0, label + ': saveToolPermissions must not run');
    assert.strictEqual(h.rec.saveInst, 0, label + ': saveInstancePermissions must not run');
    assert.strictEqual(h.rec.push.length, 0, label + ': nothing may be pushed to the SW/offscreen');
    var s = h.state();
    assert.deepStrictEqual(s.toolPermissions, h.initial.toolPermissions, label + ': tool permissions unchanged');
    assert.deepStrictEqual(s.instancePermissions, h.initial.instancePermissions, label + ': instance permissions unchanged');
    assert.deepStrictEqual(s.sessionPermissions, h.initial.sessionPermissions, label + ': session grants unchanged');
}

describe('S8B-02 permissions "Reset to defaults" asks first', function() {
    test('S8B-02 cancel keeps every permission (no save, no push, maps unchanged)', async function() {
        var h = await makeReset({ confirm: Promise.resolve(false) });
        await h.run();
        assertNothingWritten(h, 'cancel');
        assert.strictEqual(h.rec.snack.length, 0, 'no "reset" snackbar on cancel');
        assert.strictEqual(h.rec.confirm.length, 1, 'a confirm dialog is shown');
    }, { tags: ['unit'], timeout: 2000 });

    test('S8B-02 confirm resets - and only after the user confirms', async function() {
        var resolveConfirm;
        var pending = new Promise(function(r) { resolveConfirm = r; });
        var h = await makeReset({ confirm: pending });
        var done = h.run();
        await Promise.resolve();
        assert.strictEqual(h.rec.confirm.length, 1, 'the dialog is open');
        assertNothingWritten(h, 'while the dialog is open');
        resolveConfirm(true);
        await done;
        var s = h.state();
        assert.strictEqual(h.rec.saveTool, 1, 'tool permissions saved once');
        assert.strictEqual(h.rec.saveInst, 1, 'instance permissions saved once');
        assert.deepStrictEqual(s.toolPermissions, { r: 'allow', web_fetch: 'ask', w: 'auto' });
        assert.strictEqual(s.instancePermissions[h.host].tier, 'manual');
        assert.deepStrictEqual(s.instancePermissions[h.host].tools, { ir: 'allow', iw: 'ask' });
        assert.deepStrictEqual(s.instancePermissions['other.service-now.com'],
            h.initial.instancePermissions['other.service-now.com'], 'other instances untouched');
        assert.deepStrictEqual(s.sessionPermissions, {});
        assert.deepStrictEqual(h.rec.push, [{ sessionPermissions: {} }]);
        assert.strictEqual(h.rec.render, 1);
        assert.deepStrictEqual(h.rec.snack, [['All permissions reset to defaults', 'success']]);
    }, { tags: ['unit'], timeout: 2000 });

    test('S8B-02 the confirm is a danger dialog that says what will be lost', async function() {
        var h = await makeReset({ confirm: false });
        await h.run();
        assert.strictEqual(h.rec.confirm.length, 1, 'a confirm dialog is shown');
        var c = h.rec.confirm[0];
        assert.strictEqual(c.variant, 'danger');
        assert.match(c.title, /reset all permissions/i);
        assert.match(c.message, /every tool permission/i);
        assert.ok(c.message.indexOf('<strong>dev1.service-now.com</strong>') >= 0, 'names the connected instance');
        assert.match(c.message, /Manual/);
        assert.match(c.message, /session.{0,10} grants are cleared/i);
        assert.match(c.message, /cannot be undone/i);
        assertNothingWritten(h, 'cancel');
    }, { tags: ['unit'], timeout: 2000 });

    test('S8B-02 the confirm escapes the host', async function() {
        var h = await makeReset({ host: '<img src=x>', confirm: false });
        await h.run();
        assert.strictEqual(h.rec.confirm.length, 1, 'a confirm dialog is shown');
        var msg = h.rec.confirm[0].message;
        assert.ok(msg.indexOf('&lt;img src=x&gt;') >= 0, 'host is HTML-escaped');
        assert.ok(msg.indexOf('<img') < 0, 'no raw host markup');
    }, { tags: ['unit'], timeout: 2000 });

    test('S8B-02 with no connected instance the confirm omits the tier and cancel writes nothing', async function() {
        var h = await makeReset({ host: '', confirm: false });
        await h.run();
        assert.strictEqual(h.rec.confirm.length, 1, 'a confirm dialog is shown');
        assert.ok(h.rec.confirm[0].message.indexOf('Manual') < 0, 'no instance tier mentioned');
        assertNothingWritten(h, 'cancel without an instance');
    }, { tags: ['unit'], timeout: 2000 });
});
