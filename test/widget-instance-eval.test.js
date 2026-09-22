/* Run: run_tests { pattern: 'widget-instance-eval' } (js_eval sandbox; no Node).
 * Also runnable in the tool sandbox: await runWidgetEvalTests(sourceMap).
 * Exercises production functions with isolated frame/port mocks, not a second
 * implementation. Browser native fullscreen/real extension reload is manual.
 */
async function runWidgetEvalTests(sources) {
    var passed = [];
    function assert(value, message) { if (!value) throw new Error(message); }
    function check(name, value) { assert(value, name); passed.push(name); }
    function events(obj) {
        var listeners = {};
        obj.addEventListener = function(type, fn) { (listeners[type] || (listeners[type] = new Set())).add(fn); };
        obj.removeEventListener = function(type, fn) { if (listeners[type]) listeners[type].delete(fn); };
        obj.emit = function(type, event) { if (listeners[type]) Array.from(listeners[type]).forEach(function(fn) { fn(event); }); };
        return obj;
    }
    var observer = function() { this.observe = function() {}; this.disconnect = function() {}; };
    var page = events({});
    var doc = { documentElement: {} };
    var ids = 0;
    var random = { randomUUID: function() { return 'uuid-' + (++ids); } };
    var identityChats = { agent: { id: 'agent' }, background_agent: { id: 'background_agent', sourceChatId: 'origin' }, restricted: { id: 'restricted', isSubAgent: true, subAgentId: 'sub_narrow' }, full_sub: { id: 'full_sub', isSubAgent: true, subAgentId: 'sub_full' }, ambiguous: { id: 'ambiguous' } };
    var executionSource = sources['src/js/tools/020-tool-execution.js'];
    var callerSource = executionSource.slice(executionSource.indexOf('function _widgetEvalCallerError('), executionSource.indexOf('async function _executeToolInner('));
    var callerError = new Function('chats', 'SubAgents', callerSource + '\nreturn _widgetEvalCallerError;')(identityChats, { getByChatId: function(id) { return id === 'ambiguous' ? {} : null; } });
    var live = new Function('window', 'document', 'crypto', 'MutationObserver', '_widgetEvalCallerError', sources['src/js/tools/085-widget-eval.js'] + '\nreturn {register:registerWidgetInstance,unregister:unregisterWidgetInstance,list:listWidgetInstances,eval:executeWidgetEval,lookup:widgetInstanceForIframe};')(page, doc, random, observer, callerError);
    var rawEval = live.eval;
    live.eval = function(args, options) { return rawEval(args, options === undefined ? { chatId: 'agent' } : options); };
    var sandboxSource = sources['src/platform/extension/widget-sandbox.html'].split('<script>')[1].split('</script>')[0];
    // Deterministic document-owned MessagePorts; navigation preserves the
    // WindowProxy but NOT these endpoints. No browser/exploit emulation.
    function Channel() {
        function endpoint() {
            return { closed: false, onmessage: null, start: function() {}, close: function() { this.closed = true; },
                postMessage: function(data) { var peer = this.peer; if (this.closed) return;
                    queueMicrotask(function() { if (!peer.closed && peer.onmessage) peer.onmessage({ data: data }); }); } };
        }
        this.port1 = endpoint(); this.port2 = endpoint();
        this.port1.peer = this.port2; this.port2.peer = this.port1;
    }
    function frame() {
        var f = events({ isConnected: true, getRootNode: function() { return doc; }, closest: function() { return null; }, getClientRects: function() { return [1]; } });
        var parent = { postMessage: function(data, origin, ports) { queueMicrotask(function() { page.emit('message', { source: f.contentWindow, data: data, ports: ports }); }); } };
        var win = events({ parent: parent });
        var api = new Function('window', 'document', 'MessageChannel', sandboxSource + '\nreturn {setId:function(id){_widgetEvalInstanceId=id;},handle:onParentMessage,connect:connectWidgetEvalDocument};')(win, {}, Channel);
        f.contentWindow = { postMessage: function(data) { f.lastRequest = data; queueMicrotask(function() { api.handle({ source: parent, data: data }); }); } };
        var entry = live.register(f, 'widget_same');
        api.setId(entry.instance_id);
        f.sandboxWindow = win;
        f.ready = function() { api.connect(); };
        f.entry = entry;
        return f;
    }
    var a = frame(), b = frame();
    check('restricted sub execution denied before script dispatch', (await rawEval({ action: 'eval', instance_id: a.entry.instance_id, code: 'return 1;' }, { chatId: 'restricted' })).code === 'RESTRICTED_CONTEXT');
    check('full-roster sub execution also denied', (await rawEval({ action: 'eval', instance_id: a.entry.instance_id, code: 'return 1;' }, { chatId: 'full_sub' })).code === 'RESTRICTED_CONTEXT');
    check('unknown identity fails closed even with model-supplied chatId', (await rawEval({ action: 'eval', chatId: 'agent', instance_id: a.entry.instance_id, code: 'return 1;' }, {})).code === 'UNTRUSTED_CONTEXT');
    check('registry-attributed ambiguous sub cannot execute', callerError({ chatId: 'ambiguous' }).code === 'RESTRICTED_CONTEXT');
    check('sub-agents can discover instances without execution', (await rawEval({ action: 'list' }, { chatId: 'restricted' })).success);
    check('root background chat is eligible', callerError({ chatId: 'background_agent' }) === null);
    check('same saved widget gets distinct render IDs', a.entry.instance_id !== b.entry.instance_id);
    var unavailable = await live.eval({ action: 'eval', instance_id: a.entry.instance_id, code: 'return 1;' });
    check('not-ready render is unavailable', unavailable.code === 'INSTANCE_UNAVAILABLE');
    page.emit('message', { source: a.contentWindow, data: { type: 'widgetContentLoaded', instance_id: a.entry.instance_id } });
    check('WindowProxy readiness without a document port is not trusted', !a.entry.ready);
    var wrongSource = new Channel(), wrongId = new Channel();
    page.emit('message', { source: b.contentWindow, data: { type: 'widgetEvalChannel', instance_id: a.entry.instance_id }, ports: [wrongSource.port2] });
    page.emit('message', { source: a.contentWindow, data: { type: 'widgetEvalChannel', instance_id: 'unknown' }, ports: [wrongId.port2] });
    check('channel bootstrap rejects wrong source and unknown render', wrongSource.port2.closed && wrongId.port2.closed && !a.entry.ready);
    a.ready(); b.ready(); await Promise.resolve();
    function run(f, code, extra) { return live.eval(Object.assign({ action: 'eval', instance_id: f.entry.instance_id, code: code }, extra || {}), { chatId: 'agent' }); }
    var results = await Promise.all([run(a, 'this.counter=(this.counter||0)+1; await Promise.resolve(); return this.counter;'), run(b, 'this.counter=40; return this.counter;')]);
    check('two live copies execute asynchronously with independent state', results[0].result === 1 && results[1].result === 40);
    check('repeat execution preserves exact live state', (await run(a, 'return ++this.counter;')).result === 2);
    check('undefined returns null', (await run(a, 'return;')).result === null);
    for (var code of ['throw new Error("rejected");', 'return Promise.reject("rejected");', 'var x={};x.self=x;return x;', 'return ()=>1;', 'return {x:undefined};', 'return 1n;', 'return new Map();', 'return "x".repeat(70000);']) {
        check('rejects unsupported/error result: ' + code, (await run(a, code)).success === false);
    }
    var original = a.entry.port.postMessage;
    a.entry.port.postMessage = function(data) { a.lastRequest = data; };
    var waiting = run(a, 'return 3;', { timeout_ms: 100 });
    var req = a.lastRequest;
    function reply(source, id, instance, json) { page.emit('message', { source: source, data: { type: 'widgetEvalResult', request_id: id, instance_id: instance, json: json } }); }
    reply(b.contentWindow, req.request_id, req.instance_id, '{"success":true,"result":99}');
    reply(a.contentWindow, 'wrong', req.instance_id, '{"success":true,"result":99}');
    reply(a.contentWindow, req.request_id, b.entry.instance_id, '{"success":true,"result":99}');
    check('busy guard preserves pending request', (await run(a, 'return 4;')).code === 'INSTANCE_BUSY');
    check('mismatched sender/request/instance ignored until bounded timeout', (await waiting).code === 'TIMEOUT');
    var malformed = run(a, 'return 1;');
    a.entry.port.peer.postMessage({ type: 'widgetEvalResult', request_id: a.lastRequest.request_id, instance_id: a.entry.instance_id, json: '{broken' });
    check('malformed result on the original channel is rejected', (await malformed).code === 'INVALID_RESULT');
    var mismatched = run(a, 'return 1;', { timeout_ms: 100 });
    a.entry.port.peer.postMessage({ type: 'widgetEvalResult', request_id: 'wrong', instance_id: a.entry.instance_id, json: '{"success":true}' });
    a.entry.port.peer.postMessage({ type: 'widgetEvalResult', request_id: a.lastRequest.request_id, instance_id: b.entry.instance_id, json: '{"success":true}' });
    check('channel still validates request and instance IDs', (await mismatched).code === 'TIMEOUT');
    a.entry.port.postMessage = original;
    var counterBeforeWindowEval = a.sandboxWindow.counter;
    a.contentWindow.postMessage({ type: 'widgetEval', instance_id: a.entry.instance_id, request_id: 'window-forgery', code: 'this.counter=999;' });
    await Promise.resolve();
    check('sandbox ignores legacy WindowProxy eval payloads', a.sandboxWindow.counter === counterBeforeWindowEval);
    check('saved widget ID never falls back to another render', (await live.eval({ action: 'eval', instance_id: 'widget_same', code: 'return 1;' })).code === 'INSTANCE_UNAVAILABLE');
    check('invalid timeout rejected', (await run(a, 'return 1;', { timeout_ms: 99 })).code === 'INVALID_ARGUMENT');
    a.isConnected = false;
    check('detached frame pruned without recreation', !live.list().some(function(x) { return x.instance_id === a.entry.instance_id; }));
    var slow = run(b, 'this.counter++; await new Promise(resolve => { this.finish = resolve; }); return this.counter;');
    await Promise.resolve();
    check('async evaluation mutates state before delayed initial load', b.sandboxWindow.counter === 41);
    b.emit('load', {});
    await Promise.resolve(); await Promise.resolve();
    check('slow initial load preserves pending evaluation and exact identity', live.list()[0].ready && live.list()[0].instance_id === b.entry.instance_id && !!b.entry.cancel);
    b.sandboxWindow.finish();
    check('same-document delayed load retains successful async result', (await slow).result === 41);
    var bound = b.entry.port;
    var duplicate = new Channel();
    page.emit('message', { source: b.contentWindow, data: { type: 'widgetEvalChannel', instance_id: b.entry.instance_id }, ports: [duplicate.port2] });
    check('duplicate channel cannot replace original document capability', b.entry.port === bound && duplicate.port2.closed);
    var replacementMessages = [];
    b.contentWindow.postMessage = function(data) { replacementMessages.push(data); };
    check('eval uses original document port during pre-load WindowProxy replacement', (await run(b, 'return ++this.counter;')).result === 42 && replacementMessages.length === 0);
    var lost = run(b, 'this.counter++; await new Promise(resolve => { this.finish = resolve; }); return 8;');
    await Promise.resolve();
    b.sandboxWindow.emit('pagehide', {});
    check('document loss reports indeterminate after a dispatched mutation', (await lost).code === 'INDETERMINATE' && b.sandboxWindow.counter === 43);
    b.sandboxWindow.finish(); await Promise.resolve();
    check('navigation invalidates handle and closes document capability', live.list().length === 0 && bound.closed);
    var stale = new Channel();
    page.emit('message', { source: b.contentWindow, data: { type: 'widgetEvalChannel', instance_id: b.entry.instance_id }, ports: [stale.port2] });
    check('stale document cannot rebind invalidated render', stale.port2.closed && live.list().length === 0);
    var c = frame(); c.ready(); await Promise.resolve();
    c.entry.port.peer.close();
    c.emit('load', {});
    await new Promise(function(resolve) { setTimeout(resolve, 1100); });
    check('unresponsive original document probe expires without WindowProxy payload', !live.lookup(c));
    var d = frame(); d.ready(); await Promise.resolve();
    var teardown = run(d, 'await new Promise(() => {});');
    live.unregister(d);
    check('explicit teardown settles dispatched eval as indeterminate', (await teardown).code === 'INDETERMINATE');

    var chats = {}, ran = null;
    var start = new Function('chats', 'runAgent', 'currentChatId', sources['src/js/tools/150-start-chat.js'] + '\nreturn executeStartChat;')(chats, function(id) { ran = id; return Promise.resolve(); }, 'visible');
    var started = await start({ message: 'Update progress', background: true, widgetInstanceId: 'spoofed' }, { chatId: 'origin', widgetId: 'widget_same', widgetInstanceId: 'wi_real' });
    check('background start inherits authoritative origin without include_widget', started.success && chats[ran].messages[0].content.includes('instance_id=wi_real') && !chats[ran].messages[0].content.includes('spoofed'));
    check('background start preserves source chat and origin metadata', chats[ran].sourceChatId === 'origin' && chats[ran].originWidgetInstanceId === 'wi_real');

    // Execute the actual deep-link init branch and shared mount/message handler.
    // A saved-ID-only mock missed the real bug: init omitted writeWidgetHtml's
    // third argument, so the standalone interactive iframe never registered.
    var dashboardSource = sources['src/js/ui/070-dashboard-ui.js'];
    var initSource = sources['src/js/core/120-init.js'];
    var deepLinkSource = initSource.slice(initSource.indexOf('    // Deep-link to a specific widget via ?widget= parameter'), initSource.indexOf('    // Mark initial load complete'));
    assert(deepLinkSource.includes('writeWidgetHtml'), 'deep-link production branch extracted');
    var mounted = [], launches = [], dlPage = events({});
    // Minimal tree with real mount-local picker/refresh production functions.
    // No no-op attachWidgetVersionPicker shim: version changes replace frames.
    function treeNode(tag, root) {
        var attrs = {}, n = events({ tagName: tag, children: [], dataset: {}, style: {}, isConnected: true });
        n.setAttribute = function(k, v) { attrs[k] = v; };
        n.getAttribute = function(k) { return attrs[k]; };
        n.removeAttribute = function(k) { delete attrs[k]; };
        n.appendChild = function(child) { child.parentNode = n; n.children.push(child); return child; };
        n.insertBefore = function(child, before) { child.parentNode = n; n.children.splice(n.children.indexOf(before), 0, child); };
        n.remove = function() { if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = null; n.isConnected = false; };
        n.replaceWith = function(fresh) { var p = n.parentNode; p.children.splice(p.children.indexOf(n), 1, fresh); fresh.parentNode = p; n.parentNode = null; n.isConnected = false; };
        n.replaceChildren = function() { n.children = []; };
        n.getRootNode = function() { return root || (n.parentNode ? n.parentNode.getRootNode() : dlDoc); };
        n.closest = function(selector) { return selector === '[data-widget-id]' && attrs['data-widget-id'] ? n : null; };
        n.getClientRects = function() { return n.isConnected ? [1] : []; };
        n.contentWindow = { postMessage: function() {} };
        n.cloneNode = function() { var f = treeNode(tag, root); f.dataset = Object.assign({}, n.dataset); f.style = Object.assign({}, n.style); f.className = n.className; Object.keys(attrs).forEach(function(k) { f.setAttribute(k, attrs[k]); }); return f; };
        n.querySelectorAll = function(selector) {
            var out = [];
            function visit(c) {
                if (selector === '*' || selector === 'iframe[data-saved-widget-id]' && c.tagName === 'iframe' && c.dataset.savedWidgetId || selector === 'iframe.widget-iframe' && c.className === 'widget-iframe' || selector === 'style[data-widget-version-style]' && c.tagName === 'style' && c.getAttribute('data-widget-version-style') !== undefined || selector === '.widget-shadow-host' && c.className === 'widget-shadow-host') out.push(c);
                c.children.forEach(visit);
            }
            n.children.forEach(visit); return out;
        };
        n.querySelector = function(selector) { return n.querySelectorAll(selector)[0] || null; };
        return n;
    }
    var dlDoc = { documentElement: { getAttribute: function() { return 'light'; } } };
    dlDoc.body = treeNode('body', dlDoc); dlDoc.body.children = mounted;
    dlDoc.querySelectorAll = function(selector) { return dlDoc.body.querySelectorAll(selector); };
    dlDoc.createElement = function(tag) { return treeNode(tag); };
    var revisions = [{ version: 1, contentVersion: 1, html: '<p>one</p>', title: 'Saved', createdAt: 1 }];
    var pickerStore = { versions: function() { return revisions; }, view: function(id, v) { return v ? revisions.find(function(r) { return r.version === Number(v); }) : revisions[revisions.length - 1]; } };
    var pickerSource = sources['src/js/core/135-widget-store.js'];
    pickerSource = pickerSource.slice(pickerSource.indexOf('function attachWidgetVersionPicker('), pickerSource.indexOf('function getSidebarWidgets('));
    var pickerApi = new Function('document', 'WidgetStore', 'injectWidgetBridge', 'writeWidgetHtml', pickerSource + '\nreturn {attach:attachWidgetVersionPicker,select:selectWidgetRenderVersion,refresh:refreshWidgetVersionViews,frames:widgetVersionFrames};')(
        dlDoc, pickerStore, function(html) { return html; }, function() { return mount.apply(null, arguments); });
    var mountSource = dashboardSource.slice(dashboardSource.indexOf('function writeWidgetHtml('), dashboardSource.indexOf('function renderWidgetContent('));
    var mount = new Function('window', 'document', 'registerWidgetInstance', 'unregisterWidgetInstance', 'injectWidgetTokens', 'widgetInstanceForIframe', 'executeTool', 'currentChatId', 'attachWidgetVersionPicker', mountSource + '\nreturn writeWidgetHtml;')(
        dlPage, dlDoc, live.register, live.unregister, function(html) { return html; }, live.lookup,
        function(name, args, unused, options) {
            assert(name === 'start_chat', 'deep-link dispatch uses start_chat');
            var promise = start(args, options); launches.push(promise); return promise;
        }, 'origin', pickerApi.attach);
    var snapshot = { widgetId: 'widget_same', html: '<div>Static snapshot</div>' };
    var initDeepLink = new (Object.getPrototypeOf(async function() {}).constructor)('urlParams', 'getWidgetById', 'dashboardWidgets', 'document', 'window', 'injectWidgetBridge', 'writeWidgetHtml', 'chrome', deepLinkSource);
    async function openDeepLink(staticSnapshot) {
        await initDeepLink(new URLSearchParams('widget=widget_same' + (staticSnapshot ? '&snap=1' : '')),
            function() { return { title: 'Live widget', html: '<button id="refine">Refine</button>' }; }, {}, dlDoc, dlPage,
            function(html) { return html; }, mount,
            { storage: { local: { get: function(key, cb) { cb({ '__appagent_widget_snapshot__': snapshot }); } } } });
        var f = mounted[mounted.length - 1];
        // Complete only the parent's load handshake; no real widget code/tools.
        dlPage.emit('message', { source: f.contentWindow, data: { type: 'widgetSandboxReady' } });
        var entry = live.lookup(f);
        if (entry) page.emit('message', { source: f.contentWindow, data: { type: 'widgetEvalChannel', instance_id: entry.instance_id }, ports: [new Channel().port2] });
        return f;
    }
    var dlFirst = await openDeepLink(false), dlSecond = await openDeepLink(false);
    var firstOrigin = live.lookup(dlFirst), secondOrigin = live.lookup(dlSecond);
    check('actual interactive deep-link init registers a ready live render', !!firstOrigin && firstOrigin.ready && firstOrigin.widget_id === 'widget_same');
    check('separate deep-link copies receive distinct per-render origins', !!secondOrigin && firstOrigin.instance_id !== secondOrigin.instance_id);
    dlPage.emit('message', { source: dlFirst.contentWindow, data: { type: 'widgetToolCall', id: 'deep-link-click', name: 'start_chat', args: { message: 'Refine', background: true, widgetInstanceId: 'spoofed', widget_id: 'spoofed' } } });
    await Promise.all(launches);
    check('one deep-link message launches exactly one top-level chat', launches.length === 1 && !chats[ran].isSubAgent);
    check('deep-link start_chat persists and prefixes source-resolved exact origin', chats[ran].originWidgetInstanceId === firstOrigin.instance_id && chats[ran].sourceChatId === 'origin' && chats[ran].messages[0].content.startsWith('Live widget origin: instance_id=' + firstOrigin.instance_id + '.') && !chats[ran].messages[0].content.includes('spoofed'));
    var dlStatic = await openDeepLink(true);
    check('static snapshot deep-link remains unregistered and non-interactive', live.lookup(dlStatic) === null && dlStatic.className !== 'widget-iframe');
    var oldOrigin = firstOrigin.instance_id;
    dlFirst.__widgetCleanup(); dlFirst.isConnected = false;
    check('closed deep-link origin is unavailable, not redirected to same saved widget', (await live.eval({ action: 'eval', instance_id: oldOrigin, code: 'return 1;' })).code === 'INSTANCE_UNAVAILABLE' && !!live.lookup(dlSecond));
    check('deep-link saved widget ID is not an execution fallback', (await live.eval({ action: 'eval', instance_id: 'widget_same', code: 'return 1;' })).code === 'INSTANCE_UNAVAILABLE');
    check('saved render mounts actual Latest picker', dlSecond.__versionPicker.value === '' && dlSecond.__versionPicker.children[0].textContent === 'Latest (v1)');
    var originalInstance = live.lookup(dlSecond).instance_id;
    dlSecond.__versionPicker.value = '1'; dlSecond.__versionPicker.emit('change');
    var historical = pickerApi.frames().find(function(f) { return f.dataset.selectedWidgetVersion === '1'; });
    check('history selection replaces render and invalidates old eval instance', historical !== dlSecond && !live.list().some(function(e) { return e.instance_id === originalInstance; }));
    check('history selection preserves immutable HEAD', pickerStore.view().version === 1 && revisions.length === 1);
    // Dashboard open shadow root + a Latest chat copy of the same saved widget.
    var host = treeNode('div'), shadow = treeNode('shadow'); host.className = 'widget-shadow-host'; host.shadowRoot = shadow; shadow.host = host; shadow.getRootNode = function() { return shadow; }; dlDoc.body.appendChild(host);
    var dashboardFrame = treeNode('iframe', shadow); dashboardFrame.className = 'widget-iframe'; shadow.appendChild(dashboardFrame); mount(dashboardFrame, '<p>one</p>', 'widget_same');
    var chatFrame = treeNode('iframe'); chatFrame.className = 'widget-iframe'; dlDoc.body.appendChild(chatFrame); mount(chatFrame, '<p>one</p>', 'widget_same');
    check('dashboard picker styles are installed inside shadow root', !!shadow.querySelector('style[data-widget-version-style]'));
    var historicalInstance = live.lookup(historical).instance_id;
    revisions.push({ version: 2, contentVersion: 2, html: '<p>two</p>', title: 'Saved', createdAt: 2 });
    pickerApi.refresh('widget_same');
    var shadowLatest = shadow.querySelectorAll('iframe[data-saved-widget-id]')[0];
    var chatLatest = pickerApi.frames().find(function(f) { return f !== historical && f !== shadowLatest; });
    check('Latest shadow dashboard refreshes to committed revision', shadowLatest !== dashboardFrame && shadowLatest.dataset.savedWidgetVersion === '2');
    check('Latest chat refreshes to same committed revision', chatLatest !== chatFrame && chatLatest.dataset.savedWidgetVersion === '2');
    check('historical render selection and eval instance survive new commits', historical.dataset.selectedWidgetVersion === '1' && live.lookup(historical).instance_id === historicalInstance);
    check('historical picker menu receives new revision without resetting selection', historical.__versionPicker.value === '1' && historical.__versionPicker.children[0].textContent === 'Latest (v2)' && historical.__versionPicker.children.length === 3);
    check('shadow stylesheet is not duplicated on replacement', shadow.querySelectorAll('style[data-widget-version-style]').length === 1);
    var countBeforeInvalid = pickerApi.frames().length;
    pickerApi.select(historical, '999');
    check('missing revision never replaces live render', historical.isConnected && pickerApi.frames().length === countBeforeInvalid);
    historical.__versionPicker.value = ''; historical.__versionPicker.emit('change');
    check('returning to Latest follows HEAD without append', pickerApi.frames().every(function(f) { return f.dataset.savedWidgetVersion === '2'; }) && revisions.length === 2);
    pickerApi.frames().forEach(function(f) { f.__widgetCleanup(); }); dlStatic.__widgetCleanup();

    // Production worker router + production page executor with retained caches.
    // Recreate the SW closure while keeping panel state and durable chat rows.
    var worker = sources['src/js/worker/120-tool-routing.js'];
    var helper = worker.slice(worker.indexOf('var _widgetEvalCalls ='), worker.indexOf('var _executeToolLocal = executeTool;'));
    var resolver = worker.slice(worker.indexOf('function resolvePendingUIToolCall('), worker.indexOf('// MP (multi-panel'));
    var loop = sources['src/js/app/030-agent-loop.js'];
    var placeholderSource = loop.slice(loop.indexOf('function findPlaceholderRow('), loop.indexOf('function isMutationDispatched('));
    var findRow = new Function(placeholderSource + '\nreturn findPlaceholderRow;')();
    var programGuardSource = loop.slice(loop.indexOf('function getWidgetProgramReplayResult('), loop.indexOf('function synthesizeNonReplayableResult('));
    var programGuard = new Function('findPlaceholderRow', programGuardSource + '\nreturn getWidgetProgramReplayResult;')(findRow);
    var bridge = sources['src/js/app/045-agent-port-bridge-page.js'];
    var pageExecutorSource = bridge.slice(bridge.indexOf('async function _handleExecToolFromOffscreen('), bridge.indexOf('async function _handleApprovalPromptFromOffscreen('));
    var pending, adopted, buffered, router, sends = [], subscribers = new Set();
    var p1 = { id: 1 }, p2 = { id: 2 };
    subscribers.add(p1); subscribers.add(p2);
    function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
    var durableChats = { agent: { id: 'agent', messages: [] }, background_agent: { id: 'background_agent', messages: [] } };
    var disk = copy(durableChats), commits = 0, gate = null, storageMode = 'normal', heldTx = null, hydrated = true, putRequests = 0;
    var dbSource = sources['src/js/core/130-indexeddb.js'];
    var mergeSource = dbSource.slice(dbSource.indexOf('function _chatRowPutHandledFields('));
    var mergeRow = new Function('CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS', mergeSource + '\nreturn _mergeChatRowForPut;')([], []);
    // Deterministic IDB driver, not a replacement persister: actual withStore,
    // deadline wrapper, worker save and shared merge run against these requests.
    // R/W transactions serialize; request success is separate from commit and
    // aborted working copies NEVER reach disk. No browser/local data is touched.
    var transactions = [], activeTx = null;
    function startNext() {
        if (activeTx || !transactions.length) return;
        activeTx = transactions.shift(); activeTx.start();
    }
    var database = { transaction: function() {
        if (storageMode === 'fail-open') throw new Error('storage unavailable');
        var mode = storageMode, working, requests = [], started = false, ended = false, scheduled = false;
        var tx = events({ error: null });
        function finish(abort) {
            if (ended) return; ended = true;
            if (!abort) { disk = working; commits++; tx.emit('complete', {}); if (tx.oncomplete) tx.oncomplete(); }
            else { tx.emit('abort', {}); if (tx.onabort) tx.onabort(); } // real IDB fires 'abort' to listeners too
            activeTx = null; startNext();
        }
        tx.abort = function() { tx.error = new Error('transaction aborted'); finish(true); };
        tx.commit = function() { finish(false); };
        function pump() {
            scheduled = false;
            if (!started || ended) return;
            var task = requests.shift();
            if (task) { task(); schedule(); return; }
            if (mode === 'hold') { heldTx = tx; return; }
            if (mode === 'abort-after-put') { tx.abort(); return; }
            finish(false);
        }
        function schedule() { if (!scheduled) { scheduled = true; queueMicrotask(pump); } }
        function request(type, value) {
            if (mode === 'throw-' + type) throw new Error(type + ' threw');
            if (type === 'put') putRequests++;
            var req = {};
            requests.push(function() {
                if (mode === 'fail-' + type) {
                    req.error = new Error(type + ' failed');
                    var ev = { prevented: false, preventDefault: function() { this.prevented = true; } };
                    if (req.onerror) req.onerror(ev);
                    if (!ev.prevented) tx.abort();
                    return;
                }
                if (type === 'get') req.result = copy(working[value]);
                else working[value.id] = copy(value);
                if (req.onsuccess) req.onsuccess();
            });
            schedule(); return req;
        }
        tx.objectStore = function(name) {
            assert(name === 'chats', 'production intent uses real chats store');
            return { get: function(id) { return request('get', id); }, put: function(value) { return request('put', copy(value)); } };
        };
        tx.start = function() { started = true; working = copy(disk); schedule(); };
        transactions.push(tx); queueMicrotask(startNext); return tx;
    } };
    var txSource = dbSource.slice(dbSource.indexOf('function _runTxWithDeadline('), dbSource.indexOf('// =============================================================\n// SLEEP-WEDGE resume probe.'));
    var productionWithStore = new Function('openDatabase', '_isDbConnectionError', 'DB_TX_DEADLINE_READ_MS', 'DB_TX_DEADLINE_WRITE_MS', '_scopeBlockStreak', txSource + '\nreturn withStore;')(async function() { return database; }, function() { return false; }, 30000, 30000, {});
    function genericWorkerSave(memory) {
        var storageSource = sources['src/js/worker/115-storage.js'];
        return new Function('chats', 'withStore', 'chatStoreName', 'chatPayloadsStoreName', 'primeChatPayloadIdCache', 'extractChatPayloadsForPut', 'queueChatPayloadPuts', '_mergeChatRowForPut', 'CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS', '_pendingDeletes', 'console', storageSource.slice(0, storageSource.indexOf('// EXPLICIT-DELETE (chat-delete durability')) + '\n_chatsHydrated=true; return saveChatsToStorage;')(
            memory, productionWithStore, 'chats', 'chat_payloads', function(tx, cb) { cb(); }, function(chat) { return { record: copy(chat), payloads: [] }; }, function() { return 0; }, mergeRow, [], [], {}, { error: function() {}, warn: function() {} });
    }
    function genericPageSave(memory) {
        var pageSource = sources['src/js/ui/070-dashboard-ui.js'];
        var state = 'var _chatsHydrated=true, saveChatsPending=false, saveChatsPendingAgain=false, _saveChatsWaiters=[], _saveChatsBackoffUntil=0;';
        return new Function('chats', 'withStore', 'chatStoreName', 'chatPayloadsStoreName', 'primeChatPayloadIdCache', 'extractChatPayloadsForPut', 'queueChatPayloadPuts', '_mergeChatRowForPut', 'CHAT_META_TS_FIELDS', 'CHAT_META_FLAG_FIELDS', 'updateStorageIndicator', 'mirrorChatIndexToLocal', state + pageSource.slice(pageSource.indexOf('function _preserveSwOwnedChatMeta('), pageSource.indexOf('// EXPLICIT-DELETE (chat-delete durability):')) + '\nreturn saveChatsToStorage;')(
            memory, productionWithStore, 'chats', 'chat_payloads', function(tx, cb) { cb(); }, function(chat) { return { record: copy(chat), payloads: [] }; }, function() { return 0; }, mergeRow, [], [], function() {}, function() {});
    }
    function row(id, chatId) { var r = { role: 'tool', name: 'widget_eval', tool_call_id: id, _placeholder: true }; chatId = chatId || 'agent'; durableChats[chatId].messages.push(r); disk[chatId].messages.push(copy(r)); return r; }
    async function ticksUntil(predicate) { for (var n = 0; n < 100 && !predicate(); n++) await Promise.resolve(); assert(predicate(), 'async state reached'); }
    function panel(port) {
        var state = { inflight: {}, completed: {}, counter: 0 };
        state.handle = new Function('_inflightToolCalls', '_completedToolResults', '_postExecToolResult', 'executeTool', pageExecutorSource + '\nreturn _handleExecToolFromOffscreen;')(
            state.inflight, state.completed,
            function(msg) { router.resolve(msg.toolCallId, msg.result, msg.error, port); },
            async function(name, args) {
                if (args.action === 'list') return { success: true, instances: [{ instance_id: 'wi_p' + port.id }] };
                check('dispatch follows durable intent commit', commits > 0 && Object.keys(disk).some(function(id) { return disk[id].messages.some(function(m) { return m._widgetEvalDispatched; }); }));
                state.counter++;
                if (gate) await gate;
                return { success: true, result: state.counter };
            });
        return state;
    }
    var pages = { 1: panel(p1), 2: panel(p2) };
    function restart(markers, results) {
        durableChats = copy(disk); // discard volatile worker state, like real hydration
        pending = {}; adopted = markers || {}; buffered = results || {};
        function dispatch(port, chatId, id, name, input, resolve, reject, ctx) {
            sends.push({ port: port, id: id, chatId: chatId, input: input, ctx: ctx });
            pending[id] = { port: port, resolve: resolve, reject: reject };
            queueMicrotask(function() {
                if (input.action === 'eval') router.resolve(id, { success: true, result: 'forged' }, null, p1);
                pages[port.id].handle(Object.assign({ name: name, input: input, toolCallId: id, chatId: chatId }, ctx));
            });
        }
        router = new Function('_pendingUIToolCalls', '_agentSubscribers', 'dispatchUIToolToPort', 'crypto', 'activeStreamingChatId', '_panelAdoptedTools', '_adoptedResults', '_widgetEvalCallerError', 'findPlaceholderRow', 'chats', 'withStore', 'chatStoreName', '_chatsHydrated', resolver + '\n' + helper + '\nreturn {route:_routeLiveWidgetTool,resolve:resolvePendingUIToolCall,panelCall:_widgetEvalPanelCall};')(
            pending, subscribers, dispatch, random, 'focused', adopted, buffered, callerError, findRow, durableChats,
            productionWithStore, 'chats', hydrated);
    }
    restart();
    check('worker rejects sub before discovery or script dispatch', (await router.route({ action: 'eval', instance_id: 'wi_p2', code: 'return 1;' }, { chatId: 'full_sub' })).code === 'RESTRICTED_CONTEXT' && sends.length === 0);
    check('worker refuses missing trusted options identity', (await router.route({ action: 'eval', instance_id: 'wi_p2', code: 'return 1;' }, {})).code === 'UNTRUSTED_CONTEXT' && sends.length === 0);
    row('stable', 'background_agent');
    var input = { action: 'eval', instance_id: 'wi_p2', code: 'return ++this.counter;' };
    var opts = { chatId: 'background_agent', toolCallId: 'stable' };
    var routed = await router.route(input, opts);
    check('worker probes both panels and dispatches stable ID to exact owner', sends.length === 3 && sends[2].port === p2 && sends[2].id === 'stable');
    check('wrong-port result ignored and background identity retained', routed.result === 1 && sends.every(function(s) { return s.chatId === 'background_agent'; }));
    restart();
    var recovered = await router.route(input, opts);
    check('SW restart reuses retained page result without doubling mutation', recovered.result === 1 && pages[2].counter === 1 && sends[sends.length - 1].ctx.widgetEvalRecoverOnly === true);
    restart({ stable: { port: p2, chatId: 'background_agent' } }, { stable: { result: { success: true, result: 1 } } });
    var sendsBefore = sends.length;
    check('adopted completed result reconciles before discovery', (await router.route(input, opts)).result === 1 && sends.length === sendsBefore);
    restart({ stable: { port: p2, chatId: 'background_agent' } });
    var inflightRecovery = router.route(input, opts);
    await ticksUntil(function() { return !!pending.stable; });
    router.resolve('stable', { success: true, result: 'wrong' }, null, p1);
    router.resolve('stable', { success: true, result: 1 }, null, p2);
    check('live adoption waits for original owner without redispatch', (await inflightRecovery).result === 1 && sends.length === sendsBefore);
    restart({ tombstone: { dispatched: true } });
    sendsBefore = sends.length;
    check('adopted tombstone times out indeterminate without redispatch', (await router.panelCall(null, 'agent', input, { toolCallId: 'tombstone' }, 5)).code === 'INDETERMINATE' && sends.length === sendsBefore);
    restart(); delete pages[2].completed.stable;
    check('missing retained result fails indeterminate without executing', (await router.route(input, opts)).code === 'INDETERMINATE' && pages[2].counter === 1);
    row('concurrent');
    var release;
    gate = new Promise(function(resolve) { release = resolve; });
    var concurrentOpts = { chatId: 'agent', toolCallId: 'concurrent' };
    var one = router.route(input, concurrentOpts), two = router.route(input, concurrentOpts);
    await ticksUntil(function() { return !!pages[2].inflight.concurrent; });
    check('concurrent same-ID callers share one in-flight execution', pages[2].counter === 2);
    release(); gate = null;
    var both = await Promise.all([one, two]);
    check('concurrent same-ID callers both receive original result', both[0].result === 2 && both[1].result === 2);
    var parentRow = row('outer');
    var nestedOpts = { chatId: 'agent', toolCallId: 'child1', fromSandbox: true, parentToolCallId: 'outer' };
    await router.route(input, nestedOpts);
    await router.route(input, Object.assign({}, nestedOpts, { toolCallId: 'child2' }));
    check('distinct nested calls in one live program both execute', pages[2].counter === 4);
    check('outer placeholder blocks replay of entire nested program', JSON.parse(programGuard(durableChats.agent, 'outer', 'js_eval')).code === 'INDETERMINATE');
    check('direct widget tool remains eligible for result-only reconciliation', programGuard(durableChats.agent, 'outer', 'widget_eval') === null);
    restart();
    check('restarted nested relay with a fresh child ID cannot replay effects', (await router.route(input, Object.assign({}, nestedOpts, { toolCallId: 'child3' }))).code === 'INDETERMINATE' && pages[2].counter === 4);
    row('save-fails'); storageMode = 'fail-open';
    var failedSave = await router.route(input, { chatId: 'agent', toolCallId: 'save-fails' });
    storageMode = 'normal';
    check('durable intent failure prevents script dispatch', failedSave.code === 'INDETERMINATE' && pages[2].counter === 4);
    row('missing');
    check('missing exact instance never falls back to saved ID', !(await router.route({ action: 'eval', instance_id: 'widget_same', code: 'return 1;' }, { chatId: 'agent', toolCallId: 'missing' })).success && pages[2].counter === 4);
    subscribers.clear();
    check('no foreground panel fails discovery without offscreen or parking', (await router.route({ action: 'list' }, {})).code === 'INSTANCE_UNAVAILABLE');
    check('lost owner on recovery reports indeterminate', (await router.route(input, opts)).code === 'INDETERMINATE');
    subscribers.add(p1); subscribers.add(p2);
    row('survivor');
    gate = new Promise(function(resolve) { release = resolve; });
    var survivingOpts = { chatId: 'agent', toolCallId: 'survivor' };
    var beforeSurvivor = pages[2].counter;
    var oldWork = router.route(input, survivingOpts);
    await ticksUntil(function() { return !!pages[2].inflight.survivor; });
    check('real page executor retains running call before simulated restart', !!pages[2].inflight.survivor && pages[2].counter === beforeSurvivor + 1);
    // Settle obsolete worker waiter solely to clean its timer. The panel
    // promise/cache survive and post their real completion to the new worker.
    pending.survivor.reject(new Error('old worker destroyed'));
    await oldWork;
    restart({ survivor: { port: p2, chatId: 'agent' } });
    var survivingRecovery = router.route(input, survivingOpts);
    await ticksUntil(function() { return !!pending.survivor; });
    var beforeAdoptFinish = sends.length;
    release(); gate = null;
    check('actual page in-flight completion is adopted across worker restart', (await survivingRecovery).result === beforeSurvivor + 1 && pages[2].counter === beforeSurvivor + 1 && sends.length === beforeAdoptFinish);
    // Strict persistence failures must never reach even panel discovery.
    var sideEffectsBefore = pages[2].counter;
    for (var failureMode of ['fail-open', 'fail-get', 'fail-put', 'throw-get', 'throw-put', 'abort-after-put']) {
        row('strict-' + failureMode);
        var beforeDisk = JSON.stringify(disk), beforeSends = sends.length;
        storageMode = failureMode;
        var failedIntent = await router.route(input, { chatId: 'agent', toolCallId: 'strict-' + failureMode });
        storageMode = 'normal';
        check('strict intent fails closed: ' + failureMode, failedIntent.code === 'INDETERMINATE' && sends.length === beforeSends && JSON.stringify(disk) === beforeDisk);
    }
    // Exercise the REAL generic worker save: it swallows storage failures,
    // and withStore (readwrite) now rejects when the tx aborts after a put,
    // so an abort-after-put must leave the disk untouched.
    var genericMemory = copy(durableChats); genericMemory.agent.title = 'uncommitted';
    var genericSave = genericWorkerSave(genericMemory);
    storageMode = 'fail-open';
    await genericSave();
    check('actual generic save swallows storage rejection', disk.agent.title !== 'uncommitted');
    storageMode = 'abort-after-put';
    await genericSave(); await ticksUntil(function() { return !activeTx; });
    check('actual generic save leaves disk untouched when tx aborts after put', disk.agent.title !== 'uncommitted');
    storageMode = 'hold'; heldTx = null;
    // withStore (readwrite) now waits for the actual commit: a save whose
    // transaction is still uncommitted must NOT report success yet.
    var heldSaveSettled = false;
    var heldSave = genericSave().then(function() { heldSaveSettled = true; }, function() { heldSaveSettled = true; });
    await ticksUntil(function() { return !!heldTx; });
    for (var _hs = 0; _hs < 20; _hs++) await Promise.resolve();
    check('actual generic save stays pending while transaction is uncommitted', !heldSaveSettled);
    heldTx.abort(); storageMode = 'normal';
    await heldSave;
    check('actual generic save settles once the held transaction aborts', heldSaveSettled);

    row('held-intent');
    var staleSnapshot = copy(durableChats), settledIntent = false;
    storageMode = 'hold'; heldTx = null; beforeSends = sends.length;
    var heldWork = router.route(input, { chatId: 'agent', toolCallId: 'held-intent' }).then(function(value) { settledIntent = true; return value; });
    await ticksUntil(function() { return !!heldTx; });
    check('held strict transaction neither settles nor dispatches', !settledIntent && sends.length === beforeSends && !findRow(disk.agent, 'held-intent')._widgetEvalDispatched);
    // Queue both REAL generic realm saves before strict commit, each with a
    // stale pre-intent snapshot; their RMW reads must see committed intent.
    storageMode = 'normal';
    var staleWorkerWork = genericWorkerSave(copy(staleSnapshot))();
    var stalePageWork = genericPageSave(copy(staleSnapshot))();
    heldTx.commit();
    await Promise.all([heldWork, staleWorkerWork, stalePageWork]);
    await ticksUntil(function() { return !activeTx; });
    check('queued worker AND page stale saves retain committed marker', findRow(disk.agent, 'held-intent')._widgetEvalDispatched && findRow(disk.agent, 'held-intent')._widgetEvalIds.includes('held-intent'));
    var diskBeforeFailedRead = JSON.stringify(disk), putsBeforeFailedRead = putRequests;
    storageMode = 'fail-get';
    var failedReadSave = genericWorkerSave(copy(staleSnapshot));
    await Promise.all([failedReadSave(), failedReadSave()]);
    await ticksUntil(function() { return !activeTx; });
    check('worker failed reads skip blind puts and drain coalesced waiters', putRequests === putsBeforeFailedRead && JSON.stringify(disk) === diskBeforeFailedRead);
    storageMode = 'throw-get';
    await failedReadSave(); await ticksUntil(function() { return !activeTx; });
    check('worker synchronous get throw also skips unknown durable row', putRequests === putsBeforeFailedRead && JSON.stringify(disk) === diskBeforeFailedRead);
    storageMode = 'fail-get';
    await genericPageSave(copy(staleSnapshot))(); await ticksUntil(function() { return !activeTx; });
    check('page failed get aborts its blind-put fallback without committing', JSON.stringify(disk) === diskBeforeFailedRead);
    storageMode = 'normal';
    await failedReadSave(); await ticksUntil(function() { return !activeTx; });
    check('worker save continues normally after skipped failed reads', findRow(disk.agent, 'held-intent')._widgetEvalDispatched);
    restart();
    check('durable restart reads journal after queued stale writers', (await router.route(input, { chatId: 'agent', toolCallId: 'held-intent' })).result === sideEffectsBefore + 1 && pages[2].counter === sideEffectsBefore + 1);
    row('durable-outer');
    await router.route(input, { chatId: 'agent', toolCallId: 'durable-child', fromSandbox: true, parentToolCallId: 'durable-outer' });
    restart(); beforeSends = sends.length;
    check('disk-rehydrated outer program guard survives restart', JSON.parse(programGuard(durableChats.agent, 'durable-outer', 'js_eval')).replay_blocked === true);
    check('disk-rehydrated nested call cannot mint a fresh child effect', (await router.route(input, { chatId: 'agent', toolCallId: 'new-child-after-crash', fromSandbox: true, parentToolCallId: 'durable-outer' })).code === 'INDETERMINATE' && sends.length === beforeSends && pages[2].counter === sideEffectsBefore + 2);

    row('validation');
    var validDisk = copy(disk), validMemory = copy(durableChats);
    for (var invalid of ['missing-chat', 'wrong-chat', 'missing-placeholder', 'completed-placeholder', 'wrong-call', 'wrong-name', 'evicted-disk', 'evicted-memory', 'deleted-disk', 'deleted-memory', 'unhydrated']) {
        disk = copy(validDisk); restart();
        if (invalid === 'missing-chat') delete disk.agent;
        if (invalid === 'wrong-chat') disk.agent.id = 'other';
        if (invalid === 'missing-placeholder') disk.agent.messages = [];
        if (invalid === 'completed-placeholder') delete findRow(disk.agent, 'validation')._placeholder;
        if (invalid === 'wrong-call') findRow(disk.agent, 'validation').tool_call_id = 'other-call';
        if (invalid === 'wrong-name') findRow(disk.agent, 'validation').name = 'other-tool';
        if (invalid === 'evicted-disk') disk.agent._payloadsEvicted = true;
        if (invalid === 'evicted-memory') durableChats.agent._payloadsEvicted = true;
        if (invalid === 'deleted-disk') disk.agent._deleted = true;
        if (invalid === 'deleted-memory') durableChats.agent._deleted = true;
        if (invalid === 'unhydrated') { hydrated = false; restart(); hydrated = true; }
        beforeSends = sends.length;
        check('strict intent rejects ' + invalid, (await router.route(input, { chatId: 'agent', toolCallId: 'validation' })).code === 'INDETERMINATE' && sends.length === beforeSends);
    }
    disk = validDisk; durableChats = validMemory; restart();
    var completedSource = loop.slice(loop.indexOf('function recordToolResult('), loop.indexOf('// Sanctioned durable-result path'));
    var completeRow = new Function(completedSource + '\nreturn recordToolResult;')();
    var markedBeforeCompletion = copy(durableChats);
    completeRow(durableChats.agent, 'durable-outer', 'js_eval', 'done');
    await genericWorkerSave(durableChats)(); await ticksUntil(function() { return !activeTx; });
    var completed = disk.agent.messages.find(function(m) { return m.tool_call_id === 'durable-outer'; });
    check('normal completion clears placeholder and all widget intent metadata', completed.content === 'done' && !completed._placeholder && !completed._widgetEvalDispatched && !completed._widgetEvalIds && !completed._widgetEvalRun);
    await genericPageSave(markedBeforeCompletion)(); await ticksUntil(function() { return !activeTx; });
    completed = disk.agent.messages.find(function(m) { return m.tool_call_id === 'durable-outer'; });
    check('stale marked save cannot resurrect completed journal', completed.content === 'done' && !completed._placeholder && !completed._widgetEvalDispatched);

    var baseCall = { role: 'tool', name: 'js_eval', tool_call_id: 'union-root', _placeholder: true, content: '' };
    var storedCall = Object.assign({}, baseCall, { _widgetEvalDispatched: true, _widgetEvalRun: 'stored-run', _widgetEvalIds: ['a', 'b'] });
    var incomingCall = Object.assign({}, baseCall, { _widgetEvalDispatched: true, _widgetEvalRun: 'incoming-run', _widgetEvalIds: ['b', 'c'] });
    var tailRow = { role: 'user', id: 'tail', content: 'tail' };
    for (var lengths of ['equal', 'incoming-longer', 'stored-longer', 'divergent']) {
        var incoming = { id: 'same-chat', messages: [copy(incomingCall)] }, storedRow = { id: 'same-chat', messages: [copy(storedCall)] };
        if (lengths === 'incoming-longer') incoming.messages.push(tailRow);
        if (lengths === 'stored-longer') storedRow.messages.push(tailRow);
        if (lengths === 'divergent') incoming.messages.unshift(tailRow);
        var incomingBefore = JSON.stringify(incoming), storedBefore = JSON.stringify(storedRow);
        var merged = mergeRow(incoming, storedRow);
        var mergedCall = findRow(merged, 'union-root');
        check('unresolved journal union with ' + lengths + ' lengths/prefix', mergedCall._widgetEvalIds.join(',') === 'a,b,c' && mergedCall._widgetEvalRun === 'stored-run' && JSON.stringify(incoming) === incomingBefore && JSON.stringify(storedRow) === storedBefore);
    }
    check('different chat identities do not union intent', !findRow(mergeRow({ id: 'other', messages: [copy(baseCall)] }, { id: 'same', messages: [storedCall] }), 'union-root')._widgetEvalDispatched);
    check('different call identities do not union intent', !findRow(mergeRow({ id: 'same', messages: [Object.assign({}, baseCall, { tool_call_id: 'other' })] }, { id: 'same', messages: [storedCall] }), 'other')._widgetEvalDispatched);
    check('authored row removal is not resurrected by journal union', !findRow(mergeRow({ id: 'same', messages: [{ role: 'user', id: 'replacement' }] }, { id: 'same', messages: [storedCall] }), 'union-root'));
    var cleanComplete = Object.assign({}, baseCall, { content: 'done' }); delete cleanComplete._placeholder;
    check('incoming completed row beats stored unresolved intent', !mergeRow({ id: 'same', messages: [cleanComplete] }, { id: 'same', messages: [storedCall] }).messages[0]._widgetEvalDispatched);
    // Final completion race: a page/worker snapshot captured BEFORE the
    // intent was written is unmarked. Completion must dominate it too, or a
    // restart treats the whole js_eval as pending and repeats earlier effects.
    var outerAssistant = { role: 'assistant', tool_calls: [{ id: 'pre-intent-outer', function: { name: 'js_eval', arguments: '{}' } }] };
    durableChats.agent.messages.push(copy(outerAssistant)); disk.agent.messages.push(copy(outerAssistant));
    var preIntentRow = row('pre-intent-outer'); preIntentRow.name = 'js_eval';
    findRow(disk.agent, 'pre-intent-outer').name = 'js_eval';
    var beforeIntentSnapshot = copy(durableChats), counterBeforeIntent = pages[2].counter;
    var pendingScanSource = loop.slice(loop.indexOf('    var pendingToolCalls = null;'), loop.indexOf('    // Process pending tool calls from previous pause first'));
    var pendingCallsFor = new Function('chat', pendingScanSource + '\nreturn pendingToolCalls;');
    check('pre-intent unmarked outer is initially pending in production replay scan', pendingCallsFor(beforeIntentSnapshot.agent)[0].tc.id === 'pre-intent-outer');
    await router.route(input, { chatId: 'agent', toolCallId: 'pre-intent-child', fromSandbox: true, parentToolCallId: 'pre-intent-outer' });
    completeRow(durableChats.agent, 'pre-intent-outer', 'js_eval', 'outer completed');
    await genericWorkerSave(durableChats)(); await ticksUntil(function() { return !activeTx; });
    for (var staleSaveFactory of [genericWorkerSave, genericPageSave]) {
        await staleSaveFactory(copy(beforeIntentSnapshot))(); await ticksUntil(function() { return !activeTx; });
        var durableComplete = disk.agent.messages.find(function(m) { return m.tool_call_id === 'pre-intent-outer'; });
        check('pre-intent ' + (staleSaveFactory === genericWorkerSave ? 'worker' : 'page') + ' snapshot cannot erase completed outer result', durableComplete.content === 'outer completed' && !durableComplete._placeholder && !durableComplete._widgetEvalDispatched);
        restart();
        check('production replay scan after stale save and disk restart finds no pending outer program', pendingCallsFor(durableChats.agent) === null && !findRow(durableChats.agent, 'pre-intent-outer') && pages[2].counter === counterBeforeIntent + 1);
    }
    beforeSends = sends.length;
    check('late fresh nested relay after completed outer cannot dispatch', (await router.route(input, { chatId: 'agent', toolCallId: 'post-complete-child', fromSandbox: true, parentToolCallId: 'pre-intent-outer' })).code === 'INDETERMINATE' && sends.length === beforeSends && pages[2].counter === counterBeforeIntent + 1);
    var completedPrior = { role: 'tool', name: 'js_eval', tool_call_id: 'union-root', content: 'stored completion' };
    check('completion precedence does not cross chat identities', !!findRow(mergeRow({ id: 'other', messages: [copy(baseCall)] }, { id: 'same', messages: [completedPrior] }), 'union-root'));
    check('completion precedence does not cross logical call identities', !!findRow(mergeRow({ id: 'same', messages: [Object.assign({}, baseCall, { tool_call_id: 'other-call' })] }, { id: 'same', messages: [completedPrior] }), 'other-call'));
    check('authored incoming completion remains authoritative', mergeRow({ id: 'same', messages: [Object.assign({}, completedPrior, { content: 'new completion' })] }, { id: 'same', messages: [completedPrior] }).messages[0].content === 'new completion');
    var authoredRemoval = { id: 'same', messages: [{ role: 'user', id: 'replacement', content: 'edited conversation' }] };
    check('completed-call precedence does not append an intentionally removed call', !mergeRow(authoredRemoval, { id: 'same', messages: [completedPrior] }).messages.some(function(m) { return m.tool_call_id === 'union-root'; }));
    var legacyResult;
    pending.legacy = { resolve: function(value) { legacyResult = value; } };
    router.resolve('legacy', 7);
    check('legacy tool results remain backward compatible', legacyResult === 7);
    check('worker passes sender port to resolver', sources['src/js/worker/130-port-bridge.js'].includes('resolvePendingUIToolCall(msg.toolCallId, msg.result, msg.error, port)'));
    check('approved and pending replay both use nested program guard', (loop.match(/getWidgetProgramReplayResult\(chat, /g) || []).length === 3);
    check('approved and pending direct eval replay request recovery only', (loop.match(/widgetEvalRecoverOnly: toolName === 'widget_eval'/g) || []).length === 2);

    var dashboard = sources['src/js/ui/070-dashboard-ui.js'];
    check('shared mount delegates native fullscreen', dashboard.includes("iframe.setAttribute('allow', \"fullscreen *\")") && dashboard.includes("iframe.setAttribute('allowfullscreen', '')"));
    check('inline mount retains autosize cleanup while chaining lifecycle', sources['src/js/tools/080-widget-tools.js'].includes("if (typeof _mountCleanup === 'function') _mountCleanup();"));
    var dispatcher = sources['src/js/tools/020-tool-execution.js'];
    var deny = new Function('requestProgrammaticToolApproval', 'chats', dispatcher + '\nreturn executeTool;')(async function() { return { allowed: false, error: 'Denied by user' }; }, identityChats);
    check('permission denial stops before widget execution', (await deny('widget_eval', { action: 'eval', instance_id: 'wi_p2', code: 'return 1;' }, null, { chatId: 'agent' }))._denied === true);
    // PR #915 reads activeStreamingChatId/currentChatId BEFORE the permission lookup (150-tool-approval.js L24) — stub both page globals.
    var approval = new Function('getToolPermission', 'getToolDisplayName', 'activeStreamingChatId', 'currentChatId', sources['src/js/core/070-permissions.js'] + '\n' + sources['src/js/ui/150-tool-approval.js'] + '\nreturn requestProgrammaticToolApproval;')(function(name, action) { return action === 'list' ? 'allow' : 'disabled'; }, function(name) { return name; }, null, 'test-chat');
    var listApproval = await approval('widget_eval', { action: 'list', code: 'return 9;' }, {});
    var evalApproval = await approval('widget_eval', { action: 'eval' }, {});
    check('list maps to distinct read permission; code in list never executes', listApproval.allowed && listApproval.permissionKey === 'widget_eval:list');
    check('eval maps to modifying permission and respects disabled setting', !evalApproval.allowed && evalApproval.permissionKey === 'widget_eval');
    check('ordinary widget clicks keep original attribution without sticky state', dashboard.includes('widgetId: _srcWidgetId, widgetInstanceId: _srcInstance ? _srcInstance.instance_id : null, fromWidget: true') && !sources['src/js/tools/085-widget-eval.js'].includes('entry.chatId'));
    return { passed: passed.length, tests: passed };
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/core/135-widget-store.js","src/js/core/130-indexeddb.js","src/js/worker/115-storage.js","src/js/app/030-agent-loop.js","src/js/app/045-agent-port-bridge-page.js","src/js/tools/085-widget-eval.js","src/platform/extension/widget-sandbox.html","src/js/tools/150-start-chat.js","src/js/worker/120-tool-routing.js","src/js/worker/130-port-bridge.js","src/js/ui/070-dashboard-ui.js","src/js/tools/080-widget-tools.js","src/js/tools/020-tool-execution.js","src/js/core/070-permissions.js","src/js/ui/150-tool-approval.js","src/js/core/120-init.js"];
await registerRunner('widget-instance-eval', async function() { return runWidgetEvalTests(await loadSources(PATHS)); });
