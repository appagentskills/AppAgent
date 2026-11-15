// Lineage part B (4): review/audit follow-ups — bounded handover build with
// reservation release in a finally, prior progress-history cache/cap +
// state&label-matched carried-over drop, raw split-view record in the
// handover, composer-picker lineage docs, agent_status lineage filter,
// lineage-rooted widget operation ids.
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var EX = await runFile('test/extract.js', { i18n: false });
function cutFns(src, names) {
    var mask = EX.codeMask(src);
    return names.map(function(n) {
        var f = EX.findFunction(src, n, { mask: mask });
        if (!(f && f.end > f.start)) throw new Error('function not found: ' + n);
        return src.slice(f.start, f.end);
    }).join('\n');
}
function load070(chats) {
    return loadModules(['src/js/core/070-permissions.js'], { lenient: true, globals: {
        self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet, chats: chats } });
}
function cutWith(src, names, env, ret) {
    return new Function('env', 'with (env) {\n' + cutFns(src, names) + '\nreturn ' + ret + '; }')(env);
}

describe('lineage part B4', function() {
    test('fix 1: a hung handover build times out to "" and never rejects', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var fire = null;
        var env = { console: quiet, setTimeout: function(fn) { fire = fn; return 1; }, clearTimeout: function() {},
            buildLineageHandoverBlock: function() { return new Promise(function() {}); } };
        var bounded = cutWith(src, ['buildLineageHandoverBlockBounded'], env, 'buildLineageHandoverBlockBounded');
        var p = bounded('A', 10);
        assert.ok(fire, 'timeout armed');
        fire();
        assert.strictEqual(await p, '', 'timeout resolves empty');
        env.buildLineageHandoverBlock = function() { return Promise.resolve('<handover_state>\nX\n</handover_state>'); };
        assert.match(await bounded('A', 10), /handover_state/, 'fast build passes through');
        env.buildLineageHandoverBlock = function() { throw new Error('boom'); };
        assert.strictEqual(await bounded('A', 10), '', 'sync throw resolves empty');
        env.buildLineageHandoverBlock = function() { return Promise.reject(new Error('boom')); };
        assert.strictEqual(await bounded('A', 10), '', 'rejection resolves empty');
        var body = cutFns(src, ['completeSummaryAndCreateNewChat']);
        assert.match(body, /buildLineageHandoverBlockBounded\(oldChatId\)/, 'continue flow uses the bounded build');
        assert.match(body, /\}\s*finally\s*\{[\s\S]*?releaseLineageMigrationReservation\(oldChatId\)/, 'reservation released in a finally');
    }, T);

    test('fix 2: prior updates are cached per head (keyed by predecessor message counts) and capped', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var chats = { A: { id: 'A', continuedTo: 'B', messages: [] }, B: { id: 'B', continuedFrom: 'A', messages: [] } };
        for (var i = 0; i < 60; i++) chats.A.messages.push({ n: i });
        var m70 = await load070(chats);
        var calls = 0;
        var env = { chats: chats, getLineageChatIds: m70.getLineageChatIds, _lineagePriorActionUpdatesCache: {},
            LINEAGE_PRIOR_ACTION_UPDATES_MAX: 50,
            collectAllActionUpdates: function(c) { calls++; return c.messages.map(function(m) { return { state: 'running', label: 'u' + m.n }; }); } };
        var prior = cutWith(src, ['_lineageMessagesSignature', '_lineagePriorActionUpdates'], env, '_lineagePriorActionUpdates');
        var a = prior(chats.B);
        assert.strictEqual(a.length, 50, 'capped to 50');
        assert.strictEqual(a[49].label, 'u59', 'keeps the newest');
        assert.strictEqual(a[0].label, 'u10');
        prior(chats.B);
        assert.strictEqual(calls, 1, 'second render served from cache');
        a.push({ label: 'mutated' });
        assert.strictEqual(prior(chats.B).length, 50, 'cache not mutated by callers');
        chats.A.messages.push({ n: 60 });
        assert.strictEqual(prior(chats.B)[49].label, 'u60', 'predecessor growth invalidates');
        assert.strictEqual(calls, 2);
        // In-place placeholder -> result replacement keeps the length but must invalidate.
        chats.A.messages[60] = { n: 60, role: 'tool', tool_call_id: 'tc1', _placeholder: true };
        prior(chats.B);
        assert.strictEqual(calls, 3, 'placeholder seeded in place invalidates');
        prior(chats.B);
        assert.strictEqual(calls, 3, 'stable: cached');
        delete chats.A.messages[60]._placeholder;
        prior(chats.B);
        assert.strictEqual(calls, 4, 'placeholder replaced by result invalidates');
        chats.A.messages[60] = { n: 61, role: 'tool', tool_call_id: 'tc2' };
        prior(chats.B);
        assert.strictEqual(calls, 5, 'last message identity change invalidates');
    }, T);

    test('fix 3: the carried-over entry is dropped only when state AND label match the last prior', async function() {
        var src = await loadFile('src/js/tools/120-actions.js');
        var merge = cutWith(src, ['_mergeLineageActionUpdates'], {}, '_mergeLineageActionUpdates');
        var prior = [{ state: 'running', label: 'one' }, { state: 'running', label: 'two' }];
        var labels = function(l) { return l.map(function(u) { return u.state + ':' + u.label; }); };
        assert.deepStrictEqual(labels(merge(prior, [{ state: 'running', label: 'two', carriedOver: true }, { state: 'done', label: 'three' }])),
            ['running:one', 'running:two', 'done:three'], 'exact duplicate dropped');
        assert.deepStrictEqual(labels(merge(prior, [{ state: 'done', label: 'two', carriedOver: true }])),
            ['running:one', 'running:two', 'done:two'], 'state differs: kept');
        assert.deepStrictEqual(labels(merge(prior, [{ state: 'running', label: 'other', carriedOver: true }])),
            ['running:one', 'running:two', 'running:other'], 'label differs: kept');
        assert.deepStrictEqual(labels(merge([], [{ state: 'running', label: 'x', carriedOver: true }])), ['running:x'], 'no prior: unchanged');
        assert.match(cutFns(src, ['renderActionUpdatesSection']), /_mergeLineageActionUpdates\(_prior, updates\)/, 'wired into the renderer');
    }, T);

    test('fix 4: the handover finds the OLD chat split-view record (raw, not head-resolved)', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var env = { chats: {}, _splitViews: { A: { widgetId: 'widget_old' } },
            getSplitViewRecord: function() { return null; }, // resolves to the record-less head
            WidgetStore: { view: function() { return { latestVersion: 4 }; } } };
        var build = cutWith(src, ['buildLineageHandoverBlock'], env, 'buildLineageHandoverBlock');
        var out = await build('A');
        assert.match(out, /Split pane widget: widget_old \(version 4\)/);
        env._splitViews = { A: { widgetId: 'widget_old', closed: true } };
        assert.strictEqual(/Split pane/.test(await build('A')), false, 'closed marker: no line');
        env._splitViews = {};
        env.getSplitViewRecord = function(id) { return id === 'A' ? { widgetId: 'widget_fb' } : null; };
        assert.match(await build('A'), /widget_fb/, 'falls back to getSplitViewRecord');
    }, T);

    test('fix 5: composer picker lists chat-scoped docs owned by lineage predecessors and their subs', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' }, X: {} };
        var m70 = await load070(chats);
        var sdoc = await loadFile('src/js/tools/110-smart-documents.js');
        var subs = { sub_chat_1: { parent_chat_id: 'A' } };
        var sdocEnv = { getLineageChatIds: m70.getLineageChatIds, SubAgents: { getByChatId: function(id) { return subs[id] || null; } } };
        var same = cutWith(sdoc, ['_sdocChatChain', '_sdocSameLineage'], sdocEnv, '_sdocSameLineage');
        var src = await loadFile('src/js/ui/247-composer-picker.js');
        var env = { smartDocuments: {
                d_shared: { id: 'd_shared', scope: 'shared' },
                d_head: { id: 'd_head', scope: 'chat', ownerChatId: 'B' },
                d_pred: { id: 'd_pred', scope: 'chat', ownerChatId: 'A' },
                d_predsub: { id: 'd_predsub', scope: 'chat', ownerChatId: 'sub_chat_1' },
                d_other: { id: 'd_other', scope: 'chat', ownerChatId: 'X' } },
            _composerPickerChatId: function() { return 'B'; }, _composerPickerAgo: function() { return ''; },
            _composerPickerIcon: function() { return ''; }, _composerPickerEntry: function(e) { return e; },
            _sdocSameLineage: same };
        var entries = cutWith(src, ['_composerPickerDocEntries'], env, '_composerPickerDocEntries');
        var ids = function() { return entries('chat').map(function(e) { return e.id; }).sort(); };
        assert.deepStrictEqual(ids(), ['d_head', 'd_pred', 'd_predsub', 'd_shared']);
        delete env._sdocSameLineage;
        assert.deepStrictEqual(ids(), ['d_head', 'd_shared'], 'no lineage helper: exact owner only');
    }, T);

    test('fix 6: agent_status list accepts workers of a continued predecessor', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' }, X: {} };
        var m70 = await load070(chats);
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        var same = cutWith(src, ['_subLineageHead', '_subSameLineage'], { resolveLineageHead: m70.resolveLineageHead }, '_subSameLineage');
        assert.strictEqual(same('A', 'B'), true);
        assert.strictEqual(same('X', 'B'), false);
        var i = src.indexOf("if (args.parent_chat_id !== '*') {\n            var rRoot");
        assert.ok(i > 0, 'agent_status filter located');
        var block = src.slice(i, i + 700);
        assert.match(block, /_subSameLineage\(rRoot, parentChatId\) \|\| _subSameLineage\(r\.parent_chat_id, parentChatId\)/);
        assert.match(block, /typeof _subSameLineage === 'function'/, 'typeof-guarded');
    }, T);

    test('fix 7: widget operation ids: own key first, lineage-root key only for a same-content retry', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A' }, C: {} };
        var m70 = await load070(chats);
        var src = await loadFile('src/js/core/135-widget-store.js');
        // Fake store: widgetId -> [{operationId, html}]; content match = same html.
        var store = {};
        var env = { getLineageChatIds: m70.getLineageChatIds, currentChatId: 'C', crypto: { randomUUID: function() { return 'R'; } },
            widgetIdForOperation: async function(k) { return 'w(' + k + ')'; },
            WidgetStore: { hasOperation: async function(id, opId, data) {
                return (store[id] || []).some(function(v) { return v.operationId === opId && (!data || v.html === data.html); }); } } };
        var op = cutWith(src, ['_widgetOperationScopeId', 'widgetOperationId'], env, 'widgetOperationId');
        var probe = function(html, targetId) { return { targetId: targetId, data: { html: html } }; };
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }, probe('x')), 'B:o1', 'head, nothing stored: own key');
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'A' }, probe('x')), 'A:o1', 'root unchanged');
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('x')), 'C:o1', 'non-continued unchanged');
        assert.strictEqual(await op({}, { toolCallId: 't9' }), 'C:t9', 'currentChatId fallback');
        // Predecessor saved o1 with html x (root-derived widget).
        store['w(A:o1)'] = [{ operationId: 'A:o1', html: 'x' }];
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }, probe('x')), 'A:o1', 'same-content retry dedups on the root key');
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }, probe('y')), 'B:o1', 'reused id, different widget: own key (no collision)');
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }), 'B:o1', 'no probe: own key');
        // Head continued before this change already saved under its own key: own wins.
        store['w(B:o1)'] = [{ operationId: 'B:o1', html: 'z' }];
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }, probe('x')), 'B:o1', 'own-key record found first');
        // Edit retry on a target widget.
        store.T = [{ operationId: 'A:e1', html: 'h' }];
        assert.strictEqual(await op({ operation_id: 'e1' }, { chatId: 'B' }, probe('h', 'T')), 'A:e1', 'edit retry on target: root key');
        assert.strictEqual(await op({ operation_id: 'e1' }, { chatId: 'B' }, probe('other', 'T')), 'B:e1', 'edit, different content: own key');
        delete env.getLineageChatIds;
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'B' }, probe('x')), 'B:o1', 'no lineage helper: raw id');
        // Both consumers pass a content probe.
        assert.match(await loadFile('src/js/tools/080-widget-tools.js'), /widgetOperationId\(args, options, \{ targetId: targetId, data:/);
        assert.match(await loadFile('src/js/tools/010-iframe-tool.js'), /widgetOperationId\(args, options, \{ targetId: widgetId, data:/);
    }, T);

    test('fix 7b: WidgetStore.hasOperation matches operation id and content', async function() {
        var src = await loadFile('src/js/core/135-widget-store.js');
        assert.match(src, /hasOperation: hasOperation/, 'exported');
        var body = cutFns(src, ['hasOperation']);
        assert.match(body, /sameContent\(v, fingerprintOf\(payload\), payload\)/, 'content compared via fingerprint');
    }, T);

    test('fix 7c: hasOperation on a missing id never runs the legacy scan or migrate()', async function() {
        var src = await loadFile('src/js/core/135-widget-store.js');
        var body = cutFns(src, ['hasOperation']);
        assert.ok(!/migrate\(|chats\[|dashboardWidgets/.test(body), 'no legacy scan/migrate in the probe');
        var rows = { W: { versions: [{ operationId: 'op', html: 'h' }] } };
        var calls = { init: 0, fetch: 0, read: 0, migrate: 0, chats: 0 };
        var env = {
            init: async function() { calls.init++; },
            fetchRecord: async function(id) { calls.fetch++; return rows[id] || null; },
            read: async function(id) { calls.read++; return rows[id] || null; },
            migrate: async function() { calls.migrate++; },
            snapshot: function(d) { return d; }, fingerprintOf: function(p) { return p.html; },
            sameContent: function(v, fp) { return v.html === fp; },
            Array: Array
        };
        Object.defineProperty(env, 'chats', { get: function() { calls.chats++; return {}; } });
        var has = cutWith(src, ['hasOperation'], env, 'hasOperation');
        assert.strictEqual(await has('missing', 'op'), false, 'missing id: false');
        assert.strictEqual(await has('missing', 'op', { html: 'h' }), false, 'missing id with data: false');
        assert.strictEqual(calls.read, 0, 'read() (legacy scan + migrate) not called');
        assert.strictEqual(calls.migrate, 0, 'migrate() not called');
        assert.strictEqual(calls.chats, 0, 'chats not scanned');
        assert.strictEqual(calls.fetch, 2, 'store point read only');
        assert.strictEqual(await has(null, 'op'), false, 'no id: false');
        assert.strictEqual(await has('W', 'op'), true, 'existing row, op match');
        assert.strictEqual(await has('W', 'op', { html: 'h' }), true, 'same content');
        assert.strictEqual(await has('W', 'op', { html: 'x' }), false, 'different content');
        assert.strictEqual(await has('W', 'nope'), false, 'other op id');
        assert.strictEqual(calls.read, 0, 'found rows never touch read()');
        // Explicit target (edit path): legacy fallback through read() allowed.
        assert.strictEqual(await has('missing', 'op', null, true), false);
        assert.strictEqual(calls.read, 1, 'allowLegacy falls back to read()');
        // widgetOperationId passes allowLegacy only for an explicit targetId.
        assert.match(cutFns(src, ['widgetOperationId']), /var legacy = !!probe\.targetId;[\s\S]*own, null, legacy\)[\s\S]*probe\.data, legacy\)/);
    }, T);

    test('sweep: widget op ids probe EVERY predecessor (A->B->C), newest first', async function() {
        var chats = { A: { continuedTo: 'B' }, B: { continuedFrom: 'A', continuedTo: 'C' }, C: { continuedFrom: 'B' } };
        var m70 = await load070(chats);
        var src = await loadFile('src/js/core/135-widget-store.js');
        var store = {};
        var env = { getLineageChatIds: m70.getLineageChatIds, currentChatId: 'C', crypto: { randomUUID: function() { return 'R'; } },
            widgetIdForOperation: async function(k) { return 'w(' + k + ')'; },
            WidgetStore: { hasOperation: async function(id, opId, data) {
                return (store[id] || []).some(function(v) { return v.operationId === opId && (!data || v.html === data.html); }); } } };
        var op = cutWith(src, ['_widgetOperationScopeId', 'widgetOperationId'], env, 'widgetOperationId');
        var probe = function(html) { return { data: { html: html } }; };
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('x')), 'C:o1', 'nothing stored: own key');
        store['w(B:o1)'] = [{ operationId: 'B:o1', html: 'x' }];
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('x')), 'B:o1', 'retry in C of B save dedups on B key');
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('y')), 'C:o1', 'different content: own key');
        store['w(A:o1)'] = [{ operationId: 'A:o1', html: 'x' }];
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('x')), 'B:o1', 'newest predecessor wins');
        delete store['w(B:o1)'];
        assert.strictEqual(await op({ operation_id: 'o1' }, { chatId: 'C' }, probe('x')), 'A:o1', 'falls back to the root');
    }, T);

    test('sweep: deleteChat evicts _lineagePriorActionUpdatesCache[chatId]', async function() {
        var src = await loadFile('src/js/ui/170-chat-management.js');
        var i = src.indexOf('async function deleteChat(');
        assert.ok(i > 0, 'deleteChat located');
        var body = src.slice(i, i + 12000);
        assert.match(body, /typeof _lineagePriorActionUpdatesCache !== 'undefined' && _lineagePriorActionUpdatesCache\) delete _lineagePriorActionUpdatesCache\[chatId\]/);
        // Symbol is a top-level page-bundle var (tools tier), reachable from ui at runtime.
        assert.match(await loadFile('src/js/tools/120-actions.js'), /^var _lineagePriorActionUpdatesCache = \{\};$/m);
    }, T);
});
