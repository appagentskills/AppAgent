// Follow-up to PR #939 (roll-forward of #938): behavioural tests for the two
// genuine fixes that landed without one — Fix 3 (llm-streaming narrowed catch)
// and Fix 4b (agent-loop removes the partial assistant row by identity).
describe('PR #939 follow-up: remaining genuine-fix tests', function() {

    // ── Fix 3. app/010-llm-streaming.js: only JSON.parse of a wire line is skippable ──
    function sseReader(lines) {
        var enc = new TextEncoder(), i = 0;
        return { read: function() {
            if (i >= lines.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: enc.encode(lines[i++] + '\n') });
        } };
    }
    async function loadStreaming(lines) {
        var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
            getProviderById: function() { return { model: 'openai/gpt-x', endpoint: 'https://example.test/v1', apiKey: 'k' }; },
            lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'sys'; }, getEnabledTools: function() { return []; },
            getGlobalMaxTokens: function() { return 100; }, getGlobalThinkingBudget: function() { return 0; }, isAdaptiveOnlyClaude: function() { return false; }, isThinkingBindingModel: function() { return false; },
            setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
            Platform: { getReferer: function() { return 'r'; } }, console: { error: function() {}, warn: function() {}, log: function() {} },
            fetch: function() { return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return sseReader(lines); } } }); }
        } });
        assert.strictEqual(typeof m.callOpenRouterStreaming, 'function');
        return m;
    }
    function noop() {}
    function run(m, cbs) {
        return m.callOpenRouterStreaming('p', [{ role: 'user', content: 'q' }], cbs.onThinking || noop, cbs.onContent || noop, cbs.onToolCall || noop, cbs.onDone || noop, null, null, 'c1', {});
    }
    var contentLine = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] });

    test('a callback error whose message contains "JSON" propagates (base swallowed it)', async function() {
        var m = await loadStreaming([contentLine, 'data: [DONE]']), done = 0;
        await assert.rejects(run(m, { onContent: function() { throw new Error('has JSON in it'); }, onDone: function() { done++; } }),
            function(e) { return e.message === 'has JSON in it'; });
        assert.strictEqual(done, 0, 'onDone must not fire after a propagated callback error');
    });
    test('a callback error with an EMPTY message propagates (base swallowed it)', async function() {
        var m = await loadStreaming([contentLine, 'data: [DONE]']);
        await assert.rejects(run(m, { onContent: function() { throw new Error(''); } }), function(e) { return e instanceof Error && e.message === ''; });
    });
    test('an in-stream API error carries partialContent / partialThinking and isApiError', async function() {
        var thinkLine = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] });
        var errLine = 'data: ' + JSON.stringify({ error: { message: 'Unexpected token in JSON upstream', code: 502, retryable: false } });
        var m = await loadStreaming([thinkLine, contentLine, errLine]);
        await assert.rejects(run(m, {}), function(e) {
            return e.isApiError === true && e.partialContent === 'partial' && e.partialThinking === 'hmm' && e.code === 502 && e.retryable === false;
        });
    });
    test('positive control: a malformed wire line is skipped and the stream completes', async function() {
        var m = await loadStreaming(['data: {not json', contentLine, 'data: [DONE]']), final = null;
        await run(m, { onDone: function(f) { final = f; } });
        assert.ok(final, 'onDone called');
        assert.strictEqual(final.content, 'partial');
    });

    // ── Fix 4b. app/030-agent-loop.js: partial assistant row removed by identity, not pop() ──
    async function loadCatchRemoval() {
        var src = (await loadSources(['src/js/app/030-agent-loop.js']))['src/js/app/030-agent-loop.js'];
        var a = src.indexOf('var _uncommittedAssistantIndex = chat.messages.indexOf(assistantMsg);');
        assert.ok(a > 0, 'identity lookup present in the stream catch block');
        var catchStart = src.lastIndexOf('} catch (e) {', a);
        var splicePat = /if \(_uncommittedAssistantIndex >= 0\) chat\.messages\.splice\(_uncommittedAssistantIndex, 1\);/g;
        var lastSplice = src.lastIndexOf('chat.messages.splice(_uncommittedAssistantIndex, 1);');
        var region = src.slice(catchStart, lastSplice + 80);
        var removes = region.match(splicePat) || [];
        assert.ok(removes.length >= 4, 'all four former pop() sites use the identity splice (found ' + removes.length + ')');
        assert.ok(!/chat\.messages\.pop\(\)/.test(region), 'no chat.messages.pop() left in the catch region');
        var stmt = src.slice(a, src.indexOf(';', a) + 1) + '\n' + removes[0];
        return new Function('chat', 'assistantMsg', stmt + '\nreturn _uncommittedAssistantIndex;');
    }
    test('rows appended after the partial assistant row survive; the partial row is removed', async function() {
        var remove = await loadCatchRemoval();
        var assistantMsg = { role: 'assistant', content: 'partial…', isStreaming: true };
        var injected = { role: 'user', content: '[sub-agent reported]', injected: true };
        var chat = { messages: [{ role: 'user', content: 'q' }, assistantMsg, injected] };
        var idx = remove(chat, assistantMsg);
        assert.strictEqual(idx, 1);
        assert.deepStrictEqual(chat.messages.map(function(r) { return r.content; }), ['q', '[sub-agent reported]'], 'pop() would have stripped the injected row instead');
        assert.strictEqual(chat.messages.indexOf(assistantMsg), -1);
    });
    test('an already-removed partial row is a no-op (no unrelated row is dropped)', async function() {
        var remove = await loadCatchRemoval();
        var assistantMsg = { role: 'assistant', content: '' };
        var chat = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'committed answer' }] };
        assert.strictEqual(remove(chat, assistantMsg), -1);
        assert.strictEqual(chat.messages.length, 2, 'unconditional pop() would have dropped the committed answer');
    });
});

describe('IndexedDB v19 = v17 store layout (no migration)', function() {
    var V17_STORES = ['chats','settings','skills','skillAssets','widgets','dashboardWidgets','apiProviders','workspace_meta','workspace_files','workspace_blobs','documents','action_state','agent_runs','sub_agents','pending_wakes','chat_payloads'].sort();
    function fakeIndexedDB(existing) {
        var state = { version: existing ? 19 : 0, stores: existing ? existing.slice() : [], opens: [], upgrades: 0 };
        var conn = { close: function() {}, objectStoreNames: { contains: function(n) { return state.stores.indexOf(n) >= 0; } },
            addEventListener: function() {}, transaction: function() { return { objectStore: function() { return { count: function() { var r = {}; queueMicrotask(function() { r.result = 0; if (r.onsuccess) r.onsuccess({ target: r }); }); return r; } }; }, addEventListener: function() {} }; } };
        var database = Object.assign({}, conn, {
            createObjectStore: function(name) { state.stores.push(name); return { createIndex: function() {} }; },
            deleteObjectStore: function(name) { state.stores = state.stores.filter(function(s) { return s !== name; }); } });
        return { state: state, indexedDB: { open: function(name, version) {
            state.opens.push(version);
            var r = { result: database, transaction: { addEventListener: function() {} } };
            queueMicrotask(function() {
                if (version > state.version) { state.upgrades++; var old = state.version; state.version = version; r.onupgradeneeded({ target: r, oldVersion: old, newVersion: version }); }
                r.result = conn; conn.objectStoreNames = database.objectStoreNames; r.onsuccess({ target: r });
            });
            return r;
        } } };
    }
    async function load(idb) {
        return loadModules(['src/js/core/130-indexeddb.js'], { lenient: true, globals: { STORAGE_PREFIX: 'test_', skillAssetsStoreName: 'skillAssets' /* core/030-config.js */, indexedDB: idb.indexedDB, console: { warn: function() {}, error: function() {}, log: function() {} }, setTimeout: function() { return 0; }, clearTimeout: function() {} } });
    }
    test('fresh install opens at v19 and creates exactly the v17 stores', async function() {
        var idb = fakeIndexedDB(null), m = await load(idb);
        assert.strictEqual(m.dbVersion, 19);
        await m.openDatabase();
        assert.deepStrictEqual(idb.state.opens, [19]);
        assert.strictEqual(idb.state.upgrades, 1);
        assert.deepStrictEqual(idb.state.stores.slice().sort(), V17_STORES);
    });
    test('reopening an existing v19 DB (v17 layout) performs no upgrade work', async function() {
        var idb = fakeIndexedDB(V17_STORES), m = await load(idb);
        await m.openDatabase();
        assert.deepStrictEqual(idb.state.opens, [19]);
        assert.strictEqual(idb.state.upgrades, 0, 'no onupgradeneeded on a v19 DB');
        assert.deepStrictEqual(idb.state.stores.slice().sort(), V17_STORES, 'store set unchanged');
    });
    test('no temporary down-migration code remains', async function() {
        var src = await loadFile('src/js/core/130-indexeddb.js');
        // Pattern is assembled from fragments so this test file itself stays grep-clean.
        var gone = new RegExp(['_temp' + 'DownMigrate', '_TEMP' + '_V18', '_temp' + 'CleanupV18', 'oldVersion >= 18'].join('|'));
        assert.ok(!gone.test(src), 'no temporary v18 down-migration code remains');
        assert.ok(/v18 was used by reverted PR #938; v19 is the current version with the v17 store layout/.test(src));
    });
});
