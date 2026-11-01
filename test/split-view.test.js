// Split widget view (core/082-split-view.js): tool registration, per-turn
// prompt context, executor state transitions, user close, build wiring.
describe('split view', function() {
    async function fixture() {
        var stored = {};
        var g = {
            TOOLS: [], HEADLESS_TOOLS: {}, TOOL_SHORT_DESCRIPTIONS: {},
            currentChatId: 'c1', activeStreamingChatId: null,
            chrome: { storage: { local: {
                get: function(k, cb) { var o = {}; o[k] = stored[k]; cb(o); },
                set: function(o, cb) { Object.assign(stored, JSON.parse(JSON.stringify(o))); if (cb) cb(); }
            }, onChanged: { addListener: function() {} } } },
            // Sub-agent chats resolve to their root (core/070 resolveRootChatId).
            resolveRootChatId: function(id) { return { sub1: 'c1', sub2: 'c1' }[id] || id; },
            getWidgetById: function(id) { return { w1: { id: 'w1', title: 'Chart', version: 2 }, w2: { id: 'w2', title: 'Table', version: 1 } }[id] || null; },
            console: console
        };
        var m = await loadModules(['src/js/core/082-split-view.js'], { globals: g });
        return { m: m, g: g, stored: stored };
    }
    test('080 registry declares a page-only split_view tool with short description', async function() {
        var m = await loadModules(['src/js/core/080-tools.js'], { lenient: true, globals: {} });
        var tool = m.TOOLS.find(function(t) { return t.function && t.function.name === 'split_view'; });
        assert.ok(tool, 'split_view in TOOLS');
        assert.strictEqual(tool.headless, false);
        assert.ok(tool.short && tool.short.length > 10, 'stamped short');
        assert.strictEqual(m.HEADLESS_TOOLS.split_view, false);
        var f = await fixture();
        assert.strictEqual(f.g.TOOLS.length, 0, '082 no longer self-registers');
        assert.deepStrictEqual(tool.function.parameters.properties.action.enum, ['open', 'replace', 'close', 'status', 'progress']);
        assert.ok(/interactive editing/i.test(tool.function.description));
    }, { tags: ['unit'] });
    test('open -> context names the widget; replace swaps; open of another widget is refused', async function() {
        var f = await fixture();
        assert.strictEqual(f.m.buildSplitViewContext('c1'), '', 'no context when nothing shown');
        assert.strictEqual(typeof f.m._maybeAppendSplitViewContext, 'undefined', 'dead system-prompt helper removed');
        var r = await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(f.stored.appagent_split_views.c1.widgetId, 'w1', 'persisted to chrome.storage.local');
        var ctx = f.m.buildSplitViewContext('c1');
        assert.ok(ctx.indexOf('widget_id: w1; latest version: see html_widget results') !== -1, ctx);
        assert.ok(!/version v\d/.test(ctx), 'no stale version in the row (no WidgetStore in the SW)');
        assert.ok(/interactive editing of this displayed widget/.test(ctx));
        assert.ok(/expected_version/.test(ctx) && /action="replace"/.test(ctx));
        var refused = await f.m.executeSplitView({ action: 'open', widget_id: 'w2' }, { chatId: 'c1' });
        assert.strictEqual(refused.success, false);
        var rep = await f.m.executeSplitView({ action: 'replace', widget_id: 'w2' }, { chatId: 'c1' });
        assert.strictEqual(rep.success, true);
        assert.strictEqual(rep.split_view.widget_id, 'w2');
        assert.strictEqual(f.m.buildSplitViewContext('c2'), '', 'scoped per chat');
        var st = await f.m.executeSplitView({ action: 'status' }, { chatId: 'c1' });
        assert.strictEqual(st.split_view.shown, true);
        assert.strictEqual(st.split_view.title, 'Table');
        var missing = await f.m.executeSplitView({ action: 'open', widget_id: 'nope' }, { chatId: 'c3' });
        assert.strictEqual(missing.success, false);
    }, { tags: ['unit'] });
    test('user close is reflected in the context; agent close clears it', async function() {
        var f = await fixture();
        await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        await f.m.closeSplitView();
        assert.ok(/Split view: closed/.test(f.m.buildSplitViewContext('c1')));
        var st = await f.m.executeSplitView({ action: 'status' }, { chatId: 'c1' });
        assert.strictEqual(st.split_view.shown, false);
        assert.strictEqual(st.split_view.closed_by_user, true);
        await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        await f.m.executeSplitView({ action: 'close' }, { chatId: 'c1' });
        assert.strictEqual(f.m.buildSplitViewContext('c1'), '');
    }, { tags: ['unit'] });
    test('one split view per chat family: parent and subs share root state, unrelated chat does not', async function() {
        var f = await fixture();
        var r = await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'sub1' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(f.stored.appagent_split_views.c1.widgetId, 'w1', 'keyed by the root chat id');
        assert.ok(!f.stored.appagent_split_views.sub1, 'no per-sub entry');
        assert.ok(/Split view \u2014 interactive widget editing/.test(f.m.buildSplitViewContext('c1')), 'parent sees it');
        assert.ok(/widget_id: w1/.test(f.m.buildSplitViewContext('sub2')), 'sibling sub sees it');
        assert.strictEqual(f.m.buildSplitViewContext('c2'), '', 'unrelated chat has its own (empty) state');
        var st = await f.m.executeSplitView({ action: 'status' }, { chatId: 'c1' });
        assert.strictEqual(st.split_view.widget_id, 'w1');
        assert.strictEqual(st.split_view.root_chat_id, 'c1');
        f.g.currentChatId = 'sub2';
        await f.m.closeSplitView();
        assert.ok(/Split view: closed/.test(f.m.buildSplitViewContext('c1')), 'user close from a sub closes the family pane');
    }, { tags: ['unit'] });
    test('user Split view button writes the same state the tool writes and toggles closed', async function() {
        var f = await fixture();
        f.g.currentChatId = 'sub1';
        assert.strictEqual(await f.m.toggleWidgetSplitView('w2'), true);
        assert.strictEqual(f.stored.appagent_split_views.c1.widgetId, 'w2');
        assert.strictEqual(f.stored.appagent_split_views.c1.openedBy, 'user');
        assert.ok(/Split view button/.test(f.m.buildSplitViewContext('c1')), 'agent is told the user opened it');
        assert.strictEqual(f.m.isWidgetInSplitView('w2'), true);
        assert.ok(/widget-split-btn is-active/.test(f.m.splitViewButtonHtml('w2')));
        assert.ok(/toggleWidgetSplitView\('w1', event\)/.test(f.m.splitViewButtonHtml('w1')));
        await f.m.toggleWidgetSplitView('w2');
        assert.strictEqual(f.m.getSplitViewState('c1'), null, 'second click closes');
    }, { tags: ['unit'] });
    test('split pane reuses the fullscreen header builder (no duplicate version label)', async function() {
        var sv = await loadFile('src/js/core/082-split-view.js');
        var wt = await loadFile('src/js/tools/080-widget-tools.js');
        assert.ok(/buildWidgetViewHeaderHtml\(widget, 'split'\)/.test(sv), 'pane uses the shared builder');
        assert.ok(/header\.innerHTML = buildWidgetViewHeaderHtml\(widget, 'fullscreen'\)/.test(wt), 'fullscreen uses the shared builder');
        assert.strictEqual(sv.indexOf('split-widget-version'), -1, 'duplicate version label removed');
        var css = await loadFile('src/css/15b-split-view.css');
        assert.strictEqual(css.indexOf('split-widget-version'), -1);
        var m = await loadModules(['src/js/tools/080-widget-tools.js'], { lenient: true, globals: {
            dashboardWidgets: {}, chats: {}, chatWidgets: {}, currentChatId: null,
            WidgetStore: { view: function() { return null; }, versions: function() { return []; }, list: function() { return []; } },
            UI_ICONS: new Proxy({}, { get: function(o, k) { return '<i>' + String(k) + '</i>'; } }),
            escapeHtml: function(s) { return String(s); }, t: function(s) { return s; },
            isWidgetDeactivated: function() { return false; },
            splitViewButtonHtml: function(id) { return '<button class="widget-split-btn" data-widget-id="' + id + '"></button>'; }
        } });
        var w = { id: 'w9', title: 'Demo' };
        var fs = m.buildWidgetViewHeaderHtml(w, 'fullscreen');
        var sp = m.buildWidgetViewHeaderHtml(w, 'split');
        ['widget-stop-btn', 'widget-dashboard-btn', 'printWidgetFullscreen', 'screenshotWidget', 'openWidgetLink', 'widget-edit-btn', 'widget-code-btn', 'widget-modal-controls', 'Demo'].forEach(function(k) {
            assert.ok(fs.indexOf(k) !== -1 && sp.indexOf(k) !== -1, 'both surfaces carry ' + k);
        });
        assert.ok(/widget-split-btn/.test(fs) && !/widget-split-btn/.test(sp), 'split toggle only in fullscreen');
        assert.ok(/onclick="closeSplitView\(\)"/.test(sp) && !/closeSplitView/.test(fs), 'split \u00d7 closes the pane');
        assert.ok(/openWidgetFullscreen\('w9', event\)/.test(sp), 'split pane offers fullscreen');
        assert.ok(/onclick="closeWidgetFullscreen\(\)"/.test(fs));
        assert.ok(/splitViewButtonHtml\(widget\.id\)[\s\S]{0,200}widget-fullscreen-btn/.test(wt), 'inline chat card carries the split button');
        assert.ok((await loadFile('src/js/core/078-tool-profiles.js')).indexOf("'html_widget', 'widget_eval', 'split_view'") !== -1, 'split_view rides with html_widget in the orchestrator profile');
        assert.ok(/'sub-agent'[^\n]*'html_widget', 'split_view', 'widget_eval'/.test(await loadFile('src/js/core/078-tool-profiles.js')), 'and in the sub-agent profile');
    }, { tags: ['unit'] });
    test('wired into builds, permissions, dispatch, SW stub and system prompt', async function() {
        var b1 = await loadFile('build/build.js');
        var b2 = await loadFile('skills/extension-dev/build.js');
        assert.ok(b1.indexOf("'js/core/082-split-view.js'") > b1.indexOf("'js/core/080-tools.js'"));
        assert.ok(b2.indexOf("'src/js/core/082-split-view.js'") > b2.indexOf("'src/js/core/080-tools.js'"));
        assert.ok((await loadFile('src/js/core/070-permissions.js')).indexOf("'split_view'") !== -1);
        assert.ok(/name === 'split_view'[\s\S]{0,200}executeSplitView\(args, options\)/.test(await loadFile('src/js/tools/020-tool-execution.js')));
        assert.ok((await loadFile('src/js/worker/020-page-stubs.js')).indexOf('var executeSplitView') !== -1);
        var sp = await loadFile('src/js/core/100-cached-results.js');
        assert.strictEqual(sp.indexOf('_maybeAppendSplitViewContext(expanded, chatId)'), -1, 'system prompt no longer carries split state (prompt cache)');
        assert.ok(/maybePushSplitViewTailContext\(chat, streamingChatId\)/.test(await loadFile('src/js/app/030-agent-loop.js')), 'tail context row pushed from the agent loop');
    }, { tags: ['unit'] });
    test('tail context row: pushed only on signature change; status and progress', async function() {
        var f = await fixture();
        var chat = { messages: [] };
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), false, 'nothing shown and no prior row');
        await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), true);
        assert.strictEqual(chat.messages[0].role, 'context');
        assert.ok(chat.messages[0]._splitViewCtx && /widget_id: w1/.test(chat.messages[0].content));
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), false, 'same signature: no new row');
        var p = await f.m.executeSplitView({ action: 'progress', state: 'running', label: 'Building', tasks: [{ label: 'a', status: 'done' }, { label: 'b' }] }, { chatId: 'c1' });
        assert.strictEqual(p.success, true);
        assert.strictEqual(p.split_view.progress.tasks.length, 2);
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), false, 'progress is not part of the signature');
        var st = await f.m.executeSplitView({ action: 'status' }, { chatId: 'c1' });
        assert.ok(/widget_id: w1/.test(st.context) && st.split_view.pending_update === false);
        await f.m.executeSplitView({ action: 'close' }, { chatId: 'c1' });
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), true, 'closed after shown: one no-split row');
        assert.ok(/no widget is displayed/.test(chat.messages[1].content));
        assert.strictEqual(f.m.maybePushSplitViewTailContext(chat, 'c1'), false);
    }, { tags: ['unit'] });
    test('fix 2: tail signature is shown/closed + widget_id only (no version, no pendingUpdate)', async function() {
        var f = await fixture();
        await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        var a = f.m.buildSplitViewTailContext('c1');
        assert.strictEqual(a.sig, 'shown|w1');
        assert.ok(!/version v\d/.test(a.content) && /latest version: see html_widget results/.test(a.content));
        var rec = f.m.getSplitViewRecord('c1');
        await f.m.setSplitViewState('c1', Object.assign({}, rec, { pendingUpdate: true, version: 9 }));
        var b = f.m.buildSplitViewTailContext('c1');
        assert.strictEqual(b.sig, 'shown|w1', 'pendingUpdate/version do not change the signature');
        assert.strictEqual(b.content, a.content, 'row text independent of pendingUpdate/version');
        await f.m.closeSplitView();
        assert.strictEqual(f.m.buildSplitViewTailContext('c1').sig, 'closed|w1');
    }, { tags: ['unit'] });
    test('fix 1: focus alone does not hold; editable focus or recent activity does', async function() {
        var f = await fixture();
        var act = f.m._splitViewActivity;
        act.lastInputAt = 0; act.editableFocused = false;
        assert.strictEqual(f.m._splitViewIsInteracting({}), false, 'no editable focus, no recent activity');
        act.editableFocused = true;
        assert.strictEqual(f.m._splitViewIsInteracting({}), true, 'editable element focused');
        act.editableFocused = false; act.lastInputAt = Date.now() - 1000;
        assert.strictEqual(f.m._splitViewIsInteracting({}), true, 'activity in the last 5 s');
        act.lastInputAt = Date.now() - 6000;
        assert.strictEqual(f.m._splitViewIsInteracting({}), false, 'stale activity no longer holds');
        var sb = await loadFile('src/platform/extension/widget-sandbox.html');
        assert.ok(/msg\.editable = widgetIsEditable\(e\.target\)/.test(sb), 'sandbox reports editable on focusin');
        assert.ok(/isContentEditable/.test(sb) && /TEXTAREA/.test(sb) && /SELECT/.test(sb));
    }, { tags: ['unit'] });
    test('fix 5: rapid updates coalesce into a single reload of the latest version', async function() {
        var listeners = [], writes = [], ver = 1;
        var win = { addEventListener: function(t, fn) { if (t === 'message') listeners.push(fn); }, removeEventListener: function(t, fn) { listeners = listeners.filter(function(x) { return x !== fn; }); } };
        var m = await loadModules(['src/js/core/082-split-view.js'], { globals: {
            TOOLS: [], HEADLESS_TOOLS: {}, TOOL_SHORT_DESCRIPTIONS: {}, currentChatId: 'c1', console: console, window: win,
            WidgetStore: { view: function() { return { contentVersion: ver, latestVersion: ver, html: '<p>' + ver + '</p>', title: 'T' }; } },
            writeWidgetHtml: function(fr, html) { writes.push(html); fr.dataset.savedWidgetVersion = String(ver); }
        } });
        var iframe = { dataset: { savedWidgetVersion: '0' }, isConnected: true, contentWindow: { postMessage: function() {} } };
        assert.strictEqual(m.splitViewApplyUpdate(iframe, 'w1'), 'reload');
        ver = 2; assert.strictEqual(m.splitViewApplyUpdate(iframe, 'w1'), 'queued');
        ver = 3; assert.strictEqual(m.splitViewApplyUpdate(iframe, 'w1'), 'queued');
        await new Promise(function(r) { setTimeout(r, 450); });
        assert.strictEqual(writes.length, 1, 'one reload while in flight');
        assert.strictEqual(writes[0], '<p>3</p>', 'reload uses the latest version');
        listeners.slice().forEach(function(fn) { fn({ source: iframe.contentWindow, data: { type: 'widgetContentLoaded' } }); });
        await new Promise(function(r) { setTimeout(r, 0); });
        assert.strictEqual(iframe.__splitViewInFlight, false, 'flight released after load');
        assert.strictEqual(writes.length, 1, 'queued updates already covered: no second reload');
        ver = 4; assert.strictEqual(m.splitViewApplyUpdate(iframe, 'w1'), 'reload', 'next update reloads again');
    }, { tags: ['unit'] });
    test('D: sub-agent profile carries the widget collaboration tools (fixed roster)', async function() {
        var m = await loadModules(['src/js/core/078-tool-profiles.js'], { globals: { console: console } });
        var tools = m.TOOL_PROFILES['sub-agent'].tools;
        ['html_widget', 'split_view', 'widget_eval', 'report_to_parent'].forEach(function(n) { assert.ok(tools.indexOf(n) !== -1, n + ' in sub-agent profile'); });
    }, { tags: ['unit'] });
    test('D: sub-agents resolve the root split record for status and progress', async function() {
        var f = await fixture();
        await f.m.executeSplitView({ action: 'open', widget_id: 'w1' }, { chatId: 'c1' });
        var st = await f.m.executeSplitView({ action: 'status' }, { chatId: 'sub1' });
        assert.strictEqual(st.split_view.shown, true);
        assert.strictEqual(st.split_view.root_chat_id, 'c1');
        var pr = await f.m.executeSplitView({ action: 'progress', label: 'Building', tasks: [{ label: 'chart', status: 'running' }] }, { chatId: 'sub2' });
        assert.strictEqual(pr.success, true);
        assert.strictEqual(f.m.getSplitViewState('c1').progress.label, 'Building', 'sub progress lands on the root record');
    }, { tags: ['unit'] });
    test('D: VERSION_CONFLICT returns a rebase payload; auto-open only when the pane is free', async function() {
        var big = '<div data-slot="a"></div><p data-slot="b"></p>' + new Array(25001).join('x');
        var m = await loadModules(['src/js/tools/080-widget-tools.js'], { globals: {
            console: console,
            WidgetStore: { view: function() { return { html: big, latestVersion: 7 }; } },
            getSplitViewRecord: function(id) { return { busy: { widgetId: 'w1' }, closed: { closed: true, closedBy: 'user', widgetId: 'w1' } }[id] || null; }
        } });
        var out = m.widgetConflictRebasePayload('w9', { success: false, code: 'VERSION_CONFLICT', latest_version: 7 });
        assert.strictEqual(out.latest_version, 7);
        assert.deepStrictEqual(out.slots, ['a', 'b']);
        assert.strictEqual(out.html.length, 20000);
        assert.strictEqual(out.html_truncated, true);
        assert.ok(/expected_version=7/.test(out.hint));
        assert.strictEqual(m.widgetSplitPaneBusy('busy'), true, 'another widget shown: do not replace');
        assert.strictEqual(m.widgetSplitPaneBusy('closed'), false, 'user close does not suppress auto-open');
        assert.strictEqual(m.widgetSplitPaneBusy('none'), false);
    }, { tags: ['unit'] });
    test('F: right sidebar uses splitSidebarHidden in split mode and versionSidebarHidden otherwise', async function() {
        var src = await loadFile('src/js/ui/120-ui-utils.js');
        var start = src.indexOf('var versionSidebarManuallyHidden');
        var end = src.indexOf('// "Your Messages" navigation section');
        assert.ok(start !== -1 && end > start, 'sidebar block found');
        var store = { versionSidebarHidden: 'false' };
        var appStorage = { getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function(k, v) { store[k] = String(v); } };
        var cls = {}; var sidebar = { classList: { add: function(c) { cls[c] = true; }, remove: function(c) { delete cls[c]; } } };
        var document = { getElementById: function(id) { return id === 'version-sidebar' ? sidebar : null; } };
        var api = new Function('appStorage', 'document', 'resizeAllWidgets', src.slice(start, end) +
            '\nreturn { load: loadVersionSidebarState, open: openVersionSidebar, close: closeVersionSidebar, mode: applyVersionSidebarMode, hidden: function() { return versionSidebarManuallyHidden; } };')(appStorage, document, function() {});
        api.load();
        assert.strictEqual(api.hidden(), false);
        api.mode(true);
        assert.strictEqual(api.hidden(), true, 'split mode defaults to hidden');
        api.open();
        assert.strictEqual(store.splitSidebarHidden, 'false');
        assert.strictEqual(store.versionSidebarHidden, 'false', 'split toggle never writes the normal key');
        api.close();
        assert.strictEqual(store.splitSidebarHidden, 'true');
        assert.strictEqual(store.versionSidebarHidden, 'false');
        api.mode(false);
        assert.strictEqual(api.hidden(), false, 'normal state re-applied on split close');
        assert.ok(cls.visible, 'sidebar visible again');
        api.close();
        assert.strictEqual(store.versionSidebarHidden, 'true');
        assert.strictEqual(store.splitSidebarHidden, 'true', 'normal toggle never writes the split key');
        api.mode(true);
        assert.strictEqual(api.hidden(), true);
        var sv = await loadFile('src/js/core/082-split-view.js');
        assert.ok(/applyVersionSidebarMode\(active\)/.test(sv), '082 visibility sync drives the sidebar mode');
    }, { tags: ['unit'] });
});
