// WSF-EVICT / WSF-PR / WSF-SUBREFRESH: a sub-agent's edited files must reach
// the parent chat's sidebar "Workspace Files" section even after the cold
// sub chat's bodies were evicted (stripChatPayloadsInPlace), must carry the
// PR they were pushed to, and a sub chat's new messages must re-render the
// parent sidebar. Evaluates REAL source: core/130 via loadModules and the
// ui/115 helpers cut out of the workspace source by text.
describe('sidebar workspace files: sub-agent edits survive eviction', function() {
    var UI = 'src/js/ui/115-workspace-files-sidebar.js';
    var PR_URL = 'https://github.com/example-org/AppAgent/pull/1049';

    function cutDecl(src, name) {
        var m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(src);
        assert.ok(m, name + ' found in ' + UI);
        var a = m.index + 1;
        var b = src.indexOf('\n}\n', a);
        assert.ok(b > a, name + ' end found');
        return src.slice(a, b + 2);
    }
    function cutVar(src, name) {
        var m = new RegExp('\\nvar ' + name + ' = [^;\\n]+;').exec(src);
        assert.ok(m, 'var ' + name + ' found in ' + UI);
        return m[0].slice(1);
    }
    function big(ch, n) { return new Array(n + 1).join(ch); }
    function call(id, args) { return { id: id, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(args) } }; }

    var _m130 = null;
    async function core130() {
        if (!_m130) {
            _m130 = await loadModules(['src/js/core/130-indexeddb.js'], { globals: {
                STORAGE_PREFIX: 'test_',
                indexedDB: { open: function() { throw new Error('no IDB'); } },
                console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
            } });
        }
        return _m130;
    }
    var _src = null;
    async function ui115(env) {
        if (!_src) _src = await loadFile(UI);
        env = env || {};
        var body = cutVar(_src, '_wsfMutatingActions') + '\n' + cutVar(_src, '_wsfSubRenderTimer') + '\n'
            + ['_wsfScanChat', 'getWsEditedFilesForChat', '_wsfOnSubMessages'].map(function(n) { return cutDecl(_src, n); }).join('\n')
            + '\nreturn { files: getWsEditedFilesForChat, onSub: _wsfOnSubMessages };';
        return new Function('currentChatId', 'getSubAgentChatsForChat', 'renderVersionSidebar', 'setTimeout', 'clearTimeout', body)(
            env.currentChatId || null, env.getSubAgentChatsForChat, env.renderVersionSidebar || function() {},
            env.setTimeout || function(fn) { fn(); return 1; }, function() {});
    }

    function subChat() {
        return { id: 'chat_sub_w1', isSubAgent: true, messages: [
            { role: 'user', content: 'upgrade' },
            { role: 'assistant', content: '', tool_calls: [call('tc_e1', { action: 'edit', workspace: 'o/AppAgent::main', path: 'src/a.js', edits: [{ find: big('f', 400), replace: big('r', 400) }] })] },
            { role: 'tool', tool_call_id: 'tc_e1', content: JSON.stringify({ success: true, editsApplied: [], pad: big('p', 700) }) },
            { role: 'assistant', content: '', tool_calls: [call('tc_w1', { action: 'write', workspace: 'o/AppAgent::main', path: 'test/new.test.js', content: big('c', 900) })] },
            { role: 'tool', tool_call_id: 'tc_w1', content: JSON.stringify({ success: true, message: 'Created test/new.test.js', pad: big('p', 700) }) },
            { role: 'assistant', content: '', tool_calls: [call('tc_bad', { action: 'edit', workspace: 'o/AppAgent::main', path: 'src/fail.js', edits: [{ find: big('x', 600), replace: 'y' }] })] },
            { role: 'tool', tool_call_id: 'tc_bad', content: JSON.stringify({ success: false, error: 'find not unique', pad: big('p', 700) }) },
            { role: 'assistant', content: '', tool_calls: [call('tc_push', { action: 'push', workspace: 'o/AppAgent::main', branch_name: 'feat/x', files: ['src/a.js', 'test/new.test.js'] })] },
            { role: 'tool', tool_call_id: 'tc_push', content: JSON.stringify({ success: true, workspace: 'o/AppAgent::main', pr_url: PR_URL, pr_number: 1049,
                files: [{ path: 'src/a.js', isNew: false }, { path: 'test/new.test.js', isNew: true }, { path: 'src/legacy.js', isNew: false }] }) }
        ] };
    }

    test('evicted sub chat still lists its edited files with stubs', async function() {
        var m = await core130();
        var chat = subChat();
        assert.strictEqual(m.stripChatPayloadsInPlace(chat, true), true);
        var editRow = chat.messages[1], editRes = chat.messages[2];
        assert.strictEqual(editRow.tool_calls[0].function.arguments, '', 'edit args evicted');
        assert.deepStrictEqual(editRow.tool_calls[0]._wsArgs, { action: 'edit', path: 'src/a.js', dest: null, workspace: 'o/AppAgent::main' });
        assert.strictEqual(editRes.content, undefined, 'edit result evicted');
        assert.strictEqual(editRes._wsResult.success, true);
        assert.strictEqual(chat.messages[4]._wsResult.message.indexOf('Created'), 0);
        assert.strictEqual(chat.messages[6]._wsResult.success, false);

        var ui = await ui115();
        var files = ui.files(chat);
        var paths = files.map(function(f) { return f.path; });
        assert.deepStrictEqual(paths, ['src/a.js', 'test/new.test.js', 'src/legacy.js'], 'failed edit excluded, push-only file included');
        assert.strictEqual(files[1].isNew, true, 'write Created -> NEW');
        assert.strictEqual(files[0].pushedPr.url, PR_URL);
        assert.strictEqual(files[0].pushedPr.number, 1049);
        assert.strictEqual(files[2].pushOnly, true);
        assert.strictEqual(files[2].changes.length, 0);
        assert.strictEqual(files[2].isDeleted, false);
    }, { tags: ['unit'], timeout: 5000 });

    test('un-evicted chat: same list (no regression) and original rows untouched', async function() {
        var ui = await ui115();
        var chat = subChat();
        var files = ui.files(chat);
        assert.deepStrictEqual(files.map(function(f) { return f.path; }), ['src/a.js', 'test/new.test.js', 'src/legacy.js']);
        assert.strictEqual(files[0].changes.length, 1);
        assert.ok(Array.isArray(files[0].changes[0].args.edits), 'full args used when present');
    }, { tags: ['unit'], timeout: 5000 });

    test('messagesAppended from a descendant sub chat re-renders the parent sidebar; others do not', async function() {
        var renders = 0;
        var ui = await ui115({
            currentChatId: 'chat_parent',
            getSubAgentChatsForChat: function(id) { return id === 'chat_parent' ? [{ chatId: 'chat_sub_w1', name: 'w', chat: {} }] : []; },
            renderVersionSidebar: function() { renders++; }
        });
        assert.strictEqual(ui.onSub({ chatId: 'chat_sub_w1' }), true);
        assert.strictEqual(renders, 1);
        assert.strictEqual(ui.onSub({ chatId: 'chat_other' }), false);
        assert.strictEqual(ui.onSub({ chatId: 'chat_parent' }), false, 'own chat handled by renderMessages');
        assert.strictEqual(renders, 1);
    }, { tags: ['unit'], timeout: 5000 });
});
