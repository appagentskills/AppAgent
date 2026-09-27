// PR-CHIP: a sub-agent chat's PR chip must survive cold-chat body eviction
// (PR-1), and the sidebar's durable meta.prs fallback must read EVERY
// workspace meta (PR-2) and never drop a refresh requested mid-load (S-1).
// Evaluates REAL source: core/130 via loadModules (stripChatPayloadsInPlace,
// chatHasEvictableBodies, CHAT_BODY_EVICT_MIN_CHARS) and the ui/120 sidebar
// helpers (getPushedPRsForChat, getSubAgentChatsForChat, _sidebarMetaPRsUnion,
// _refreshSidebarMetaPRs + their three cache vars) cut out of the workspace
// source by text. Only chats / currentChatId / subAgentsForChatTree /
// getAllWorkspaceMetas and a renderVersionSidebar spy are faked. No timers:
// every fake settles on microtasks.
describe('sidebar PR chip: push rows survive eviction + meta.prs union', function() {
    var UI = 'src/js/ui/120-ui-utils.js';
    var UI_FNS = ['getPushedPRsForChat', 'getSubAgentChatsForChat', '_sidebarMetaPRsUnion', '_refreshSidebarMetaPRs'];
    var UI_VARS = ['_sidebarMetaPRs', '_sidebarMetaPRsLoading', '_sidebarMetaPRsDirty'];
    var PR_URL = 'https://github.com/example-org/AppAgent/pull/901';
    var PR2 = 'https://github.com/example-org/AppAgent/pull/902';
    var PR3 = 'https://github.com/example-org/AppAgent/pull/903';

    // realDecl pattern (test/chat-boot-load.test.js cutDecl), over one read.
    function cutDecl(src, name) {
        var m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(src);
        assert.ok(m, name + ' found in ' + UI);
        var a = m.index + 1;
        var b = src.indexOf('\n}\n', a);
        assert.ok(b > a, name + ' end found in ' + UI);
        return src.slice(a, b + 2);
    }
    function cutVar(src, name) {
        var m = new RegExp('\\nvar ' + name + ' = [^;\\n]+;').exec(src);
        assert.ok(m, 'var ' + name + ' found in ' + UI);
        return m[0].slice(1);
    }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function big(ch, n) { return new Array(n + 1).join(ch); }
    function urls(list) { return (list || []).map(function(p) { return p.url; }); }
    async function ticks(n) { for (var i = 0; i < (n || 12); i++) await Promise.resolve(); }

    var _m130 = null;
    async function core130() {
        if (!_m130) {
            _m130 = await loadModules(['src/js/core/130-indexeddb.js'], { globals: {
                STORAGE_PREFIX: 'test_',
                indexedDB: { open: function() { throw new Error('no IDB in sidebar-pr-chip tests'); } },
                console: { log: function() {}, info: function() {}, warn: function() {}, error: function() {} }
            } });
        }
        return _m130;
    }

    var _uiSrc = null;
    async function ui120(env) {
        if (!_uiSrc) _uiSrc = await loadFile(UI);
        env = env || {};
        var body = UI_VARS.map(function(n) { return cutVar(_uiSrc, n); }).join('\n') + '\n'
            + UI_FNS.map(function(n) { return cutDecl(_uiSrc, n); }).join('\n')
            + '\nreturn { pushed: getPushedPRsForChat, subs: getSubAgentChatsForChat,'
            + ' union: _sidebarMetaPRsUnion, refresh: _refreshSidebarMetaPRs,'
            + ' state: function() { return { prs: _sidebarMetaPRs, loading: _sidebarMetaPRsLoading, dirty: _sidebarMetaPRsDirty }; } };';
        // parseWsKey is shadowed as undefined: the refresh guard must not need it.
        return new Function('chats', 'currentChatId', 'subAgentsForChatTree', 'getAllWorkspaceMetas', 'renderVersionSidebar', 'parseWsKey', body)(
            env.chats || {}, env.currentChatId || null, env.subAgentsForChatTree,
            env.getAllWorkspaceMetas, env.renderVersionSidebar || function() {}, undefined);
    }

    function call(id, name, args) {
        var c = { type: 'function', function: { name: name, arguments: args } };
        if (id) c.id = id;
        return c;
    }
    function pushArgs(extra) {
        return JSON.stringify(Object.assign({ action: 'push', branch_name: 'fix/pr-chip', pr_title: 'Fix PR chip eviction',
            commit_message: 'fix: keep push rows resident', pr_body: big('b', 900),
            files: ['src/js/core/130-indexeddb.js'] }, extra || {}));
    }
    function pushResult(extra) {
        var files = [];
        for (var i = 0; i < 24; i++) files.push({ path: 'src/js/file_' + i + '.js', status: 'modified', last_modified_by_chat_id: 'chat_sub_w1' });
        return JSON.stringify(Object.assign({ success: true, pr_url: PR_URL, pr_number: 901, branch: 'fix/pr-chip',
            base_branch: 'main', pr_reused: false, files: files }, extra || {}));
    }
    // A retired sub-agent chat: one unrelated heavy call/result pair + one push.
    function subChat() {
        return { id: 'chat_sub_w1', title: 'Worker', isSubAgent: true, retiredSubAgent: true, createdAt: 1, updatedAt: 2, messages: [
            { role: 'user', content: 'do the fix' },
            { role: 'assistant', content: '', tool_calls: [call('tc_fetch', 'web_fetch', JSON.stringify({ url: 'https://example.com', body: big('q', 700) }))] },
            { role: 'tool', tool_call_id: 'tc_fetch', content: big('r', 2000) },
            { role: 'assistant', content: '', tool_calls: [call('tc_push', 'workspace', pushArgs())] },
            { role: 'tool', tool_call_id: 'tc_push', content: pushResult() },
            { role: 'assistant', content: 'Pushed ' + PR_URL }
        ] };
    }

    test('evicted sub-agent chat keeps its push rows; the PR reaches its own and the parent roll-up scan', async function() {
        var m = await core130();
        assert.strictEqual(m.CHAT_BODY_EVICT_MIN_CHARS, 512);
        var chat = subChat();
        var before = clone(chat);
        var pushCallRow = chat.messages[3], pushResRow = chat.messages[4];
        assert.ok(before.messages[3].tool_calls[0].function.arguments.length > 512, 'push args are over the floor');
        assert.ok(before.messages[4].content.length > 512, 'push result is over the floor');
        assert.strictEqual(m.chatHasEvictableBodies(chat), true, 'pre-strip: the web_fetch rows are evictable');

        assert.strictEqual(m.stripChatPayloadsInPlace(chat, true), true);
        assert.strictEqual(chat._payloadsEvicted, true);
        // Unrelated heavy rows evict exactly as before.
        assert.strictEqual(chat.messages[2].content, undefined, 'unrelated long tool result evicted');
        assert.strictEqual(chat.messages[2]._bodyEvicted, true);
        assert.strictEqual(chat.messages[1].tool_calls[0].function.arguments, '', 'long non-push args blanked');
        assert.strictEqual(chat.messages[1].tool_calls[0].function.name, 'web_fetch', 'call name kept');
        // Push rows are untouched: same row objects, full text, no evicted flag.
        assert.strictEqual(chat.messages[3], pushCallRow, 'push call row not cloned');
        assert.strictEqual(chat.messages[4], pushResRow, 'push result row not cloned');
        assert.strictEqual(chat.messages[3].tool_calls[0].function.arguments, before.messages[3].tool_calls[0].function.arguments);
        assert.strictEqual(chat.messages[4].content, before.messages[4].content);
        assert.strictEqual(chat.messages[3]._bodyEvicted, undefined);
        assert.strictEqual(chat.messages[4]._bodyEvicted, undefined);
        // Nothing left for the sweep pre-scan; a second strip is a no-op.
        assert.strictEqual(m.chatHasEvictableBodies(chat), false);
        assert.strictEqual(m.stripChatPayloadsInPlace(chat, true), false);

        var expected = [{ url: PR_URL, number: 901, title: 'Fix PR chip eviction', branch: 'fix/pr-chip', base: 'main' }];
        var treeCalls = [];
        var chatsMap = { chat_parent: { id: 'chat_parent', messages: [{ role: 'user', content: 'go' }] }, chat_sub_w1: chat };
        var ui = await ui120({ chats: chatsMap, currentChatId: 'chat_parent', subAgentsForChatTree: function(id) {
            treeCalls.push(id);
            return [{ agent_id: 'sub_w1', name: 'fixer', chat_id: 'chat_sub_w1', state: 'stopped' },
                { agent_id: 'sub_gone', name: 'gone', chat_id: 'chat_sub_gone', state: 'stopped' }];
        } });
        assert.deepStrictEqual(ui.pushed(chat), expected, 'the sub chat itself still yields its PR');
        var subs = ui.subs('chat_parent');
        assert.deepStrictEqual(treeCalls, ['chat_parent']);
        assert.deepStrictEqual(subs.map(function(s) { return [s.chatId, s.name]; }), [['chat_sub_w1', 'fixer']]);
        assert.strictEqual(subs[0].chat, chat);
        var rolled = [];
        subs.forEach(function(sc) { ui.pushed(sc.chat).forEach(function(pr) { rolled.push(pr); }); });
        assert.deepStrictEqual(rolled, expected, 'parent roll-up surfaces the evicted sub-agent PR');
        // Control: the pre-fix eviction of these two rows is exactly what lost the chip.
        var legacy = clone(chat);
        legacy.messages[3].tool_calls[0].function.arguments = '';
        delete legacy.messages[4].content;
        assert.deepStrictEqual(ui.pushed(legacy), [], 'control: evicted push rows yield no PR');
    }, { tags: ['unit'], timeout: 5000 });

    test('only workspace push rows are exempt: other pr_url rows, failed pushes, id-less and non-push calls still evict', async function() {
        var m = await core130();
        var chat = { id: 'c2', messages: [
            // A long tool row BEFORE any push call (the id map is still null).
            { role: 'tool', tool_call_id: 'tc_early', content: JSON.stringify({ pr_url: PR_URL, pad: big('e', 700) }) },
            { role: 'assistant', content: '', tool_calls: [
                call('tc_short', 'workspace', JSON.stringify({ action: 'push', branch_name: 'fix/short' })),
                call('tc_fail', 'workspace', JSON.stringify({ action: 'push', branch_name: 'fix/fail', pr_body: big('f', 700) })),
                call(null, 'workspace', JSON.stringify({ action: 'push', branch_name: 'fix/noid', pr_body: big('n', 700) })),
                call('tc_status', 'workspace', JSON.stringify({ action: 'status', include_prs: 'full', pad: big('s', 700) })),
                call('tc_git', 'git_tool', JSON.stringify({ action: 'push', pad: big('g', 700) })),
                call('tc_await', 'await_handle', JSON.stringify({ handle: 'h_1' }))
            ] },
            { role: 'tool', tool_call_id: 'tc_short', content: pushResult({ pr_url: PR2, pr_number: 902, branch: 'fix/short' }) },
            { role: 'tool', tool_call_id: 'tc_fail', content: JSON.stringify({ success: false, error: 'push rejected: ' + big('x', 700) }) },
            { role: 'tool', tool_call_id: 'tc_status', content: JSON.stringify({ success: true, prs: [{ pr_url: PR_URL }], pad: big('y', 700) }) },
            { role: 'tool', tool_call_id: 'tc_git', content: JSON.stringify({ success: true, pr_url: PR3, pad: big('z', 700) }) },
            { role: 'tool', tool_call_id: 'tc_await', content: JSON.stringify({ status: 'done', data: { pr_url: PR_URL }, summary: big('w', 700) }) }
        ] };
        var before = clone(chat);
        assert.strictEqual(m.chatHasEvictableBodies(chat), true);
        assert.strictEqual(m.stripChatPayloadsInPlace(chat, true), true);
        var tcs = chat.messages[1].tool_calls;
        assert.deepStrictEqual(tcs.map(function(t) { return t.function.arguments === ''; }),
            [false, false, true, true, true, false],
            'kept: short push, long push (tc_fail), short await; blanked: id-less push, workspace status, git_tool push');
        assert.strictEqual(tcs[1].function.arguments, before.messages[1].tool_calls[1].function.arguments, 'failed push keeps its args');
        assert.deepStrictEqual(chat.messages.map(function(x) { return x.role === 'tool' ? typeof x.content : '-'; }),
            ['undefined', '-', 'string', 'undefined', 'undefined', 'undefined', 'undefined'],
            'kept: short-args push result; evicted: early row, failed push, status, git_tool, await_handle (all but the failed push carry pr_url)');
        assert.strictEqual(chat.messages[2].content, before.messages[2].content);
        assert.strictEqual(m.chatHasEvictableBodies(chat), false);
        var ui = await ui120({});
        assert.deepStrictEqual(ui.pushed(chat), [{ url: PR2, number: 902, title: 'fix/short', branch: 'fix/short', base: 'main' }]);
    }, { tags: ['unit'], timeout: 5000 });

    test('chatHasEvictableBodies mirrors the strip exemption row for row', async function() {
        var m = await core130();
        function base() {
            return [{ role: 'assistant', content: '', tool_calls: [call('tc_p', 'workspace', pushArgs())] },
                { role: 'tool', tool_call_id: 'tc_p', content: pushResult() }];
        }
        var rows = {
            earlyLong: { role: 'tool', tool_call_id: 'tc_x', content: JSON.stringify({ pr_url: PR_URL, pad: big('e', 700) }) },
            awaitPrUrl: [{ role: 'assistant', tool_calls: [call('tc_a', 'await_handle', '{"handle":"h"}')] },
                { role: 'tool', tool_call_id: 'tc_a', content: JSON.stringify({ data: { pr_url: PR_URL }, pad: big('a', 700) }) }],
            otherIdPrUrl: { role: 'tool', tool_call_id: 'tc_other', content: pushResult() },
            idless: { role: 'assistant', tool_calls: [call(null, 'workspace', pushArgs())] },
            status: { role: 'assistant', tool_calls: [call('tc_s', 'workspace', JSON.stringify({ action: 'status', pad: big('s', 700) }))] },
            gitPush: { role: 'assistant', tool_calls: [call('tc_g', 'git_tool', JSON.stringify({ action: 'push', pad: big('g', 700) }))] },
            thinking: { role: 'assistant', content: 'x', thinking: big('t', 600) },
            reasoning: { role: 'assistant', content: 'x', reasoning_details: [{ type: 'reasoning.text', text: 'why' }] },
            short: { role: 'tool', tool_call_id: 'tc_z', content: 'ok' }
        };
        var variants = [
            ['exempt push rows only', base(), false],
            ['failed push result (no pr_url)', [base()[0], { role: 'tool', tool_call_id: 'tc_p', content: JSON.stringify({ success: false, error: big('x', 700) }) }], true],
            ['long pr_url row before the push call', [rows.earlyLong].concat(base()), true],
            ['await_handle row carrying pr_url', base().concat(rows.awaitPrUrl), true],
            ['pr_url row answering another call id', base().concat([rows.otherIdPrUrl]), true],
            ['id-less push call with long args', base().concat([rows.idless]), true],
            ['workspace status call with long args', base().concat([rows.status]), true],
            ['non-workspace call with action push', base().concat([rows.gitPush]), true],
            ['long thinking', base().concat([rows.thinking]), true],
            ['reasoning_details', base().concat([rows.reasoning]), true],
            ['short rows + null row', [null, rows.short, { role: 'user', content: 'hi' }], false]
        ];
        variants.forEach(function(v) {
            var c = { id: 'v', messages: clone(v[1]) };
            assert.strictEqual(m.chatHasEvictableBodies(c), v[2], 'pre-scan: ' + v[0]);
            var s = { id: 'v', messages: clone(v[1]) };
            assert.strictEqual(m.stripChatPayloadsInPlace(s, true), v[2], 'strip agrees: ' + v[0]);
            assert.strictEqual(s._payloadsEvicted, v[2] ? true : undefined, 'evicted flag: ' + v[0]);
            assert.strictEqual(m.chatHasEvictableBodies(s), false, 'post-strip pre-scan: ' + v[0]);
        });
        assert.strictEqual(m.chatHasEvictableBodies(null), false);
        assert.strictEqual(m.chatHasEvictableBodies({ messages: 'x' }), false);
    }, { tags: ['unit'], timeout: 5000 });

    test('meta.prs union: pinned then recency, first URL wins, only merged/closed lent, inputs untouched', async function() {
        var ui = await ui120({});
        var G = 'https://github.com/o/';
        var metas = [
            { repo: 'o/a::main', github_repo: 'o/a', last_used_at: 300, prs: [
                { url: G + 'a/pull/1', number: 1, title: 'a1', branch: 'fix/a1', chatId: 'chat_1' },
                { url: G + 'a/pull/2', number: 2, title: 'a2 base', branch: 'fix/a2', chatId: 'chat_2' }] },
            { repo: 'o/b::main', github_repo: 'o/b', pinned: true, last_used_at: 100, prs: [
                { url: G + 'b/pull/3', number: 3, title: 'b3', state: 'open' }] },
            { repo: 'o/a::feature', github_repo: 'o/a', last_used_at: 200, prs: [
                { url: G + 'a/pull/2', number: 2, title: 'a2 fork', state: 'merged' }, null, { number: 7, title: 'no url' },
                { url: G + 'b/pull/3', number: 3, title: 'b3 dup', state: 'merged' },
                { url: G + 'a/pull/4', number: 4, title: 'a4' }] },
            { repo: 'o/c::main', cloned_at: 250, prs: null },
            { repo: 'o/d::main', last_used_at: 400, prs: 'nope' },
            null,
            { prs: [{ url: G + 'x/pull/9', number: 9 }] },
            { repo: 'o/e::main', cloned_at: 350, prs: [{ url: G + 'e/pull/5', number: 5, title: 'e5' }] },
            { repo: 'o/a::old', last_used_at: 150, prs: [
                { url: G + 'a/pull/1', number: 1, title: 'a1 old', state: 'closed' },
                { url: G + 'a/pull/4', number: 4, title: 'a4 old', state: 'open' }] },
            { repo: 'o/f::main', pinned: true, last_used_at: 50, prs: [{ url: G + 'f/pull/6', number: 6, title: 'f6' }] }
        ];
        var snap = clone(metas);
        var out = ui.union(metas);
        assert.deepStrictEqual(out, [
            { url: G + 'b/pull/3', number: 3, title: 'b3', state: 'open' },
            { url: G + 'f/pull/6', number: 6, title: 'f6' },
            { url: G + 'e/pull/5', number: 5, title: 'e5' },
            { url: G + 'a/pull/1', number: 1, title: 'a1', branch: 'fix/a1', chatId: 'chat_1', state: 'closed' },
            { url: G + 'a/pull/2', number: 2, title: 'a2 base', branch: 'fix/a2', chatId: 'chat_2', state: 'merged' },
            { url: G + 'a/pull/4', number: 4, title: 'a4' }
        ]);
        assert.deepStrictEqual(clone(metas), snap, 'input metas (order, prs, states) are not mutated');
        assert.notStrictEqual(out[4], metas[0].prs[1], 'state-lent entry is a clone');
        assert.strictEqual('state' in metas[0].prs[1], false);
        assert.deepStrictEqual(ui.union([]), []);
        assert.deepStrictEqual(ui.union(null), []);
        assert.deepStrictEqual(ui.union(undefined), []);

        // _refreshSidebarMetaPRs caches exactly the union (parseWsKey shadowed undefined).
        var renders = 0;
        var ui2 = await ui120({ getAllWorkspaceMetas: function() { return Promise.resolve(metas); },
            renderVersionSidebar: function() { renders++; } });
        ui2.refresh();
        await ticks();
        assert.deepStrictEqual(ui2.state(), { prs: out, loading: false, dirty: false });
        assert.strictEqual(renders, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('a refresh requested mid-load re-runs once when the load settles (resolve and reject), never loops', async function() {
        var OLD = [{ repo: 'o/r::main', last_used_at: 1, prs: [{ url: PR_URL, number: 901 }] }];
        var NEW = [{ repo: 'o/r::main', last_used_at: 2, prs: [{ url: PR_URL, number: 901 }, { url: PR2, number: 902, chatId: 'chat_x' }] }];
        function env(onRender) {
            var e = { loads: [], renders: [] };
            e.getAllWorkspaceMetas = function() {
                var d = {};
                d.promise = new Promise(function(res, rej) { d.resolve = res; d.reject = rej; });
                e.loads.push(d);
                return d.promise;
            };
            e.renderVersionSidebar = function() { e.renders.push(urls(e.ui.state().prs)); if (onRender) onRender(e); };
            return e;
        }
        // Resolve path.
        var a = env(function(e) { if (e.ui.state().prs === null) e.ui.refresh(); }); // renderVersionSidebar's lazy call
        a.ui = await ui120(a);
        a.ui.refresh();
        assert.strictEqual(a.loads.length, 1);
        assert.deepStrictEqual(a.ui.state(), { prs: null, loading: true, dirty: false });
        a.ui.refresh(); // e.g. the second workspaceMutated of one push
        assert.strictEqual(a.loads.length, 1, 'no overlapping load');
        assert.strictEqual(a.ui.state().dirty, true, 'mid-load request recorded, not dropped');
        a.loads[0].resolve(clone(OLD));
        await ticks();
        assert.strictEqual(a.loads.length, 2, 'dirty cache re-ran once');
        assert.deepStrictEqual(a.renders, [[PR_URL]]);
        assert.deepStrictEqual(a.ui.state(), { prs: OLD[0].prs, loading: true, dirty: false });
        a.loads[1].resolve(clone(NEW));
        await ticks();
        assert.deepStrictEqual(a.ui.state(), { prs: NEW[0].prs, loading: false, dirty: false }, 'the late PR landed');
        assert.deepStrictEqual(a.renders, [[PR_URL], [PR_URL, PR2]]);
        await ticks(40);
        assert.strictEqual(a.loads.length, 2, 'settled: exactly 2 loads, no loop');
        a.ui.refresh();
        a.loads[2].resolve(clone(NEW));
        await ticks();
        assert.strictEqual(a.loads.length, 3);
        assert.strictEqual(a.renders.length, 2, 'an unchanged list does not re-render');

        // Reject path: a dirty request still re-runs; a clean rejection does not retry.
        var r = env();
        r.ui = await ui120(r);
        r.ui.refresh();
        r.ui.refresh();
        r.loads[0].reject(new Error('idb closed'));
        await ticks();
        assert.strictEqual(r.loads.length, 2, 'rejected load re-ran for the mid-load request');
        assert.deepStrictEqual(r.ui.state(), { prs: null, loading: true, dirty: false });
        r.loads[1].resolve(clone(NEW));
        await ticks();
        assert.deepStrictEqual(urls(r.ui.state().prs), [PR_URL, PR2]);
        assert.strictEqual(r.renders.length, 1);
        r.ui.refresh();
        r.loads[2].reject(new Error('again'));
        await ticks(40);
        assert.strictEqual(r.loads.length, 3, 'clean rejection: no retry loop');
        assert.deepStrictEqual(r.ui.state(), { prs: NEW[0].prs, loading: false, dirty: false });

        // A load started by the render itself satisfies the earlier request (no redundant 3rd load).
        var s = env(function(e) { if (e.renders.length === 1) e.ui.refresh(); });
        s.ui = await ui120(s);
        s.ui.refresh();
        s.ui.refresh();
        s.loads[0].resolve(clone(OLD));
        await ticks();
        assert.strictEqual(s.loads.length, 2);
        assert.strictEqual(s.ui.state().dirty, false, 'the render-started load cleared the earlier request');
        s.loads[1].resolve(clone(NEW));
        await ticks(40);
        assert.strictEqual(s.loads.length, 2, 'no redundant third load');
        assert.deepStrictEqual(urls(s.ui.state().prs), [PR_URL, PR2]);

        // No getAllWorkspaceMetas: a no-op, never stuck loading.
        var n = await ui120({});
        n.refresh();
        assert.deepStrictEqual(n.state(), { prs: null, loading: false, dirty: false });
    }, { tags: ['unit'], timeout: 5000 });
});
