// Follow-ups to sweep #952: F1-F5 minor fixes.
describe('#952 follow-ups (F1-F5)', function() {
    function sliceFn(src, sig) {
        var i = src.indexOf(sig);
        assert.ok(i >= 0, sig + ' must exist');
        var j = src.indexOf('\nfunction ', i + sig.length);
        var k = src.indexOf('\nasync function ', i + sig.length);
        var end = [j, k].filter(function(x) { return x > 0; }).sort(function(a, b) { return a - b; })[0];
        return src.slice(i, end || src.length);
    }

    test('F4: page stop-phrase regex is byte-identical to the SW one', async function() {
        var sw = await loadFile('src/js/worker/120-tool-routing.js');
        var pg = await loadFile('src/js/app/040-send-message.js');
        var swRe = /var _SW_STOP_PHRASE_RE = (\/.*\/[a-z]*);/.exec(sw);
        var pgRe = /var _PAGE_STOP_PHRASE_RE = (\/.*\/[a-z]*);/.exec(pg);
        assert.ok(swRe && pgRe, 'both regex literals must be present');
        assert.strictEqual(pgRe[1], swRe[1]);
        var m = await loadModules(['src/js/app/040-send-message.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        assert.strictEqual(m._pageIsStopPhrase('  Stop  '), true);
        assert.strictEqual(m._pageIsStopPhrase('no thanks.'), true);
        assert.strictEqual(m._pageIsStopPhrase('no problem, go ahead'), false);
        assert.ok(/_cancelViaChat \? 'Cancelling the pending question/.test(pg), 'cancel spinner text wired');
    }, { tags: ['unit'], timeout: 5000 });

    test('F2: send-message re-checks the tombstone after the rehydrate await', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var body = sliceFn(src, 'async function _handlePanelSendMessage(');
        var aw = body.indexOf('await ensureChatPayloads(chatId)');
        var chk = body.indexOf('_swSendTargetDeleted(chatId)', aw);
        var push = body.indexOf("chats[chatId].messages.push({ role: 'user'", aw);
        assert.ok(aw > 0 && chk > aw && push > chk, 'tombstone re-check must sit between the await and the push');
        var run = body.lastIndexOf('runAgent(chatId)');
        assert.ok(body.lastIndexOf('_swSendTargetDeleted(chatId)') < run, 'second re-check precedes runAgent');
        assert.ok(/function _swSendTargetDeleted\(chatId\)[\s\S]{0,80}return !c \|\| !!c\._deleted;/.test(src));
    }, { tags: ['unit'], timeout: 5000 });

    test('F5: _swRemoveWidgets stamps _dirtyWhileEvicted on a still-evicted chat', async function() {
        var src = await loadFile('src/js/worker/130-port-bridge.js');
        var body = sliceFn(src, 'function _swRemoveWidgets(');
        assert.ok(/if \(c\._payloadsEvicted\) c\._dirtyWhileEvicted = true;/.test(body));
        var storage = await loadFile('src/js/worker/115-storage.js');
        assert.ok(/_dirtyWhileEvicted\) _rescueDirtyEvictedChat\(id\)/.test(storage), 'rescue consumer exists');
    }, { tags: ['unit'], timeout: 5000 });

    test('F1: join waiter is probed; SW answers query-running', async function() {
        var pg = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var sw = await loadFile('src/js/worker/130-port-bridge.js');
        assert.ok(/_watchJoinedRun\(chatId, _joinEntry\);\s*return _joinPromise;/.test(pg), 'join path arms the probe');
        assert.ok(/case 'running-state':\s*[\s\S]{0,120}_resolveRunningState\(msg\)/.test(pg), 'page resolves probe replies');
        assert.ok(/case 'query-running':[\s\S]{0,700}type: 'running-state'/.test(sw), 'SW replies to the probe');
        var w = sliceFn(pg, 'function _watchJoinedRun(');
        assert.ok(/if \(_pendingRunAgents\[chatId\] !== entry\) return;/.test(w), 'identity guard');
        assert.ok(/_firstProbe && _jc && !_jc\._deleted/.test(w), 'real run only on the first probe for a live chat');
        assert.ok(/RUN_JOIN_PROBE_MAX_SILENT/.test(w), 'bounded when SW is silent');
    }, { tags: ['unit'], timeout: 5000 });

    // Behavioral: evaluate the REAL _watchJoinedRun source with stubbed deps.
    async function makeWatch(answers, chatsMap) {
        var pg = await loadFile('src/js/app/045-agent-port-bridge-page.js');
        var i = pg.indexOf('function _watchJoinedRun(');
        var end = pg.indexOf('\n}\n', i) + 3;
        var env = { running: { c1: true }, pending: {}, chats: chatsMap, runs: [], timers: [], renders: 0 };
        var q = answers.slice();
        var fn = new Function('runningChatIds', '_pendingRunAgents', 'chats', '_queryRunningOnSW', 'runAgent',
            'setTimeout', 'renderChatList', '_agentBusPort', 'RUN_JOIN_PROBE_MAX_SILENT', 'RUN_JOIN_PROBE_INTERVAL_MS',
            pg.slice(i, end) + '\nreturn _watchJoinedRun;')(
            env.running, env.pending, env.chats,
            function() { return Promise.resolve(q.length ? q.shift() : null); },
            function(cid) { env.runs.push(cid); return Promise.resolve(); },
            function(f) { env.timers.push(f); return 1; },
            function() { env.renders++; }, {}, 3, 20000);
        env.watch = fn;
        env.entry = { resolved: 0 };
        env.entry.resolve = function() { env.entry.resolved++; };
        env.pending.c1 = env.entry;
        return env;
    }
    async function flush() { for (var n = 0; n < 10; n++) await Promise.resolve(); }

    test('F1: first probe false on a live stale flag DOES start a real run', async function() {
        var env = await makeWatch([false], { c1: { id: 'c1', messages: [] } });
        env.watch('c1', env.entry);
        await flush();
        assert.deepStrictEqual(env.runs, ['c1']);
        assert.strictEqual(env.running.c1, undefined);
        assert.strictEqual(env.pending.c1, undefined);
        assert.strictEqual(env.entry.resolved, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('F1: a LATER probe returning false settles WITHOUT runAgent', async function() {
        var env = await makeWatch([true, false], { c1: { id: 'c1', messages: [] } });
        env.watch('c1', env.entry);
        await flush();
        assert.strictEqual(env.timers.length, 1, 're-probe armed after running:true');
        env.timers[0]();
        await flush();
        assert.deepStrictEqual(env.runs, []);
        assert.strictEqual(env.running.c1, undefined);
        assert.strictEqual(env.pending.c1, undefined);
        assert.strictEqual(env.entry.resolved, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('F1: a deleted (or missing) chat never gets runAgent', async function() {
        var env = await makeWatch([false], { c1: { id: 'c1', messages: [], _deleted: true } });
        env.watch('c1', env.entry);
        await flush();
        assert.deepStrictEqual(env.runs, []);
        assert.strictEqual(env.entry.resolved, 1);
        var env2 = await makeWatch([false], {});
        env2.watch('c1', env2.entry);
        await flush();
        assert.deepStrictEqual(env2.runs, []);
        assert.strictEqual(env2.entry.resolved, 1);
    }, { tags: ['unit'], timeout: 5000 });

    test('F1: page flag already cleared (disconnect/hello) → stop probing, no run, entry left to grace', async function() {
        var env = await makeWatch([false], { c1: { id: 'c1', messages: [] } });
        delete env.running.c1;
        env.watch('c1', env.entry);
        await flush();
        assert.deepStrictEqual(env.runs, []);
        assert.strictEqual(env.pending.c1, env.entry, 'entry untouched for the hello grace / safety');
        assert.strictEqual(env.timers.length, 0);
        assert.strictEqual(env.entry.resolved, 0);
    }, { tags: ['unit'], timeout: 5000 });

    test('F3: Model ID typing refreshes effort visuals without rewriting the value', async function() {
        var src = await loadFile('src/js/ui/040-tools-settings.js');
        var fn = sliceFn(src, 'function onModelIdInput(');
        assert.ok(/onModalEffortSliderInput\(effortSlider\.value, true\)/.test(fn));
        var sl = sliceFn(src, 'function onModalEffortSliderInput(');
        assert.ok(/if \(hidden && !keepValue\) hidden\.value/.test(sl));
    }, { tags: ['unit'], timeout: 5000 });
});
