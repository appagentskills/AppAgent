// Security follow-ups from the fresh-context review of PRs #919/#920/#921/#923.
// 1 run_tests/run_js_file stale-bundle guard · 2 stop phrases against a pending
// prompt_user cancel it AND keep the interrupt lane · 3 force-taken rows are not
// handed to the root chat on sub park/stop · 4 wsPush stale-branch reset needs an
// explicit pr_title · 6 tool-arm throws become failed results, not run crashes.
describe('security follow-ups (#919/#920/#921/#923 review)', function() {
    var T = null, R = null;
    async function tools() {
        if (T) return T;
        T = await loadModules(['src/js/tools/020-tool-execution.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return T;
    }
    async function routing() {
        if (R) return R;
        R = await loadModules(['src/js/worker/120-tool-routing.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        return R;
    }

    // ---- 1 -------------------------------------------------------------
    test('#1 run_tests / run_js_file arms are typeof-guarded and the guard returns the rebuild hint', async function() {
        var m = await tools();
        var r = m._runTestsImplMissing('run_tests');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /run_tests impl not loaded in this bundle/);
        assert.match(r.error, /tools\/160-run-tests\.js missing/);
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        assert.ok(/typeof executeRunJsFile !== 'function'\) return _runTestsImplMissing\('run_js_file'\)/.test(src), 'run_js_file arm guarded');
        assert.ok(/typeof executeRunTests !== 'function'\) return _runTestsImplMissing\('run_tests'\)/.test(src), 'run_tests arm guarded');
    });

    // ---- 2 -------------------------------------------------------------
    function armPrompt(m, rows, pending) {
        var events = [];
        m.__scope.chats = { c1: { id: 'c1', messages: rows } };
        m.__scope.saveChatsToStorage = function() { events.push('save'); };
        m.__scope.AgentEvents = { emit: function(n) { events.push(n); } };
        m.__scope.parkedToolCallsByChatId = {};
        var pend = m._pendingUIToolCalls;
        Object.keys(pend).forEach(function(k) { delete pend[k]; });
        Object.keys(pending || {}).forEach(function(k) { pend[k] = pending[k]; });
        return events;
    }
    function promptRow(tcId) { return { role: 'prompt_user', promptId: 'p_' + tcId, toolCallId: tcId, status: 'pending' }; }
    test('#2 _swIsStopPhrase: stop/cancel/abort/no/don\u2019t/halt/wait/hold on (case-insensitive, leading) vs ordinary answers', async function() {
        var m = await routing();
        ['stop', 'STOP', 'stop.', 'Stop!', ' Cancel ', 'cancel that', 'abort it', 'No', 'no.', 'No thanks', "don't", "don't do it", 'Don\u2019t do that', 'halt', 'wait', 'Hold on', 'nope', 'do not', 'do not do this'].forEach(function(s) {
            assert.strictEqual(m._swIsStopPhrase(s), true, JSON.stringify(s) + ' is a stop phrase');
        });
        // Whole-message only: a stop word followed by real content is an ANSWER.
        ['yes', 'go ahead', 'blue', 'nothing else', 'stopwatch please', 'notify me', 'Do it', 'no problem, go ahead', 'wait, actually yes', 'stop asking and do it', 'No, use the other table', "Don't forget to also X", '', null, undefined].forEach(function(s) {
            assert.strictEqual(m._swIsStopPhrase(s), false, JSON.stringify(s) + ' is NOT a stop phrase');
        });
    });
    test('#2 stop phrase against a pending prompt \u2192 settled as the standard cancel shape (+cancelled_via_chat, text), row cancelled, returns FALSE (interrupt lane runs)', async function() {
        var m = await routing();
        var got = null;
        var events = armPrompt(m, [promptRow('tc1')], { tc1: { resolve: function(r) { got = r; }, reject: function() {}, name: 'prompt_user' } });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', '  Stop  '), false, 'false → caller sets userInterruptedChats');
        assert.ok(got, 'pending prompt resolved');
        assert.strictEqual(got.success, false);
        assert.strictEqual(got.cancelled, true, 'mirrors cancelPromptUser: success:false, cancelled:true');
        assert.strictEqual(got.cancelled_via_chat, true);
        assert.strictEqual(got.text, 'Stop');
        assert.match(got.message, /cancelled the form via chat/);
        assert.strictEqual(got.answered_via_chat, undefined);
        var row = m.__scope.chats.c1.messages[0];
        assert.strictEqual(row.status, 'cancelled');
        assert.strictEqual(row.cancelled_via_chat, true);
        assert.strictEqual(m._pendingUIToolCalls.tc1, undefined, 'pending entry consumed');
        assert.ok(events.indexOf('messagesAppended') >= 0 && events.indexOf('save') >= 0);
    });
    test('#2 ordinary answer still settles as answered_via_chat and returns TRUE (unchanged)', async function() {
        var m = await routing();
        var got = null;
        armPrompt(m, [promptRow('tc2')], { tc2: { resolve: function(r) { got = r; }, reject: function() {} } });
        assert.strictEqual(m._swAnswerPendingPromptViaChat('c1', 'yes, go ahead'), true);
        assert.strictEqual(got.success, true);
        assert.strictEqual(got.answered_via_chat, true);
        assert.strictEqual(m.__scope.chats.c1.messages[0].status, 'submitted');
    });
    test('#2 wiring: port bridge still marks userInterruptedChats when the helper returns false', async function() {
        var bridge = await loadFile('src/js/worker/130-port-bridge.js');
        var body = bridge.slice(bridge.indexOf('function _handlePanelSendMessage('));
        var fast = body.indexOf('_swAnswerPendingPromptViaChat(chatId, msg.text)) return;');
        var mark = body.indexOf('userInterruptedChats[chatId] = true');
        assert.ok(fast > 0 && mark > fast && mark - fast < 200, 'interrupt flag set right after a false return');
    });

    // ---- 3 -------------------------------------------------------------
    function armWs(m, files) {
        var writes = [];
        m.__scope.getAllWorkspaceFilesAllRepos = async function() { return files.map(function(f) { var raw = Object.assign({}, f); delete raw.content; return raw; }); };
        m.__scope.getWorkspaceFile = async function(repo, path) { for (var i = 0; i < files.length; i++) if (files[i].repo === repo && files[i].path === path) return files[i]; return null; };
        m.__scope.setWorkspaceFile = async function(f) { writes.push(f.path); };
        m.__scope.chats = { root1: { id: 'root1', title: 'Root' }, sub1: { id: 'sub1', title: 'sub' } };
        m.__scope.SubAgents = { getByChatId: function(id) { return id === 'sub1' ? { chat_id: 'sub1', root_chat_id: 'root1' } : null; } };
        m.__scope.isChatRunning = function() { return false; };
        m.__scope.wsGetIgnoreFilter = async function() { return function() { return false; }; };
        return writes;
    }
    function wsFile(path, owner, extra) { return Object.assign({ repo: 'o/r::main', path: path, dirty: true, content: 'x', last_modified_by_chat_id: owner, last_modified_by_chat_title: owner, last_modified_at: 1 }, extra || {}); }
    test('#3 _wsConflictDecision(force) reports force_taken_from for a foreign owner, null for own lineage / unowned', async function() {
        var m = await tools();
        armWs(m, []);
        var foreign = await m._wsConflictDecision('o/r::main', 'a.js', wsFile('a.js', 'otherChat', { last_modified_at: Date.now() }), 'sub1', true);
        assert.strictEqual(foreign.block, null); assert.strictEqual(foreign.warn, null);
        assert.strictEqual(foreign.force_taken_from, 'otherChat');
        var own = await m._wsConflictDecision('o/r::main', 'a.js', wsFile('a.js', 'root1', { last_modified_at: Date.now() }), 'sub1', true);
        assert.strictEqual(own.force_taken_from, null, 'same lineage is not a takeover');
        var none = await m._wsConflictDecision('o/r::main', 'a.js', wsFile('a.js', null), 'sub1', true);
        assert.strictEqual(none.force_taken_from, null);
        var noForce = await m._wsConflictDecision('o/r::main', 'a.js', wsFile('a.js', 'root1'), 'sub1', false);
        assert.strictEqual(noForce.force_taken_from, undefined, 'non-force path unchanged');
    });
    test('#3/B11 _wsNextForceTakenFrom: new takeover wins; reclaim by the taken-from lineage clears the stale marker; otherwise carried', async function() {
        var m = await tools();
        armWs(m, []);
        assert.strictEqual(m._wsNextForceTakenFrom({ force_taken_from: 'otherChat' }, null, 'sub1'), 'otherChat', 'new takeover stamped');
        assert.strictEqual(m._wsNextForceTakenFrom({ force_taken_from: 'third' }, 'otherChat', 'sub1'), 'third', 'newest takeover wins');
        assert.strictEqual(m._wsNextForceTakenFrom({}, 'otherChat', 'otherChat'), null, 'original owner reclaims → cleared');
        assert.strictEqual(m._wsNextForceTakenFrom({}, 'root1', 'sub1'), null, 'same lineage as the taken-from owner → cleared');
        assert.strictEqual(m._wsNextForceTakenFrom({}, 'otherChat', 'sub1'), 'otherChat', 'unrelated chat piling on → marker carried');
        assert.strictEqual(m._wsNextForceTakenFrom({}, 'otherChat', null), 'otherChat', 'no chat id → carried');
        assert.strictEqual(m._wsNextForceTakenFrom({}, null, 'sub1'), null, 'no marker stays null');
        assert.strictEqual(m._wsNextForceTakenFrom(undefined, undefined, 'sub1'), null);
    });
    test('#3 _wsTransferOwnership skips force_taken_from rows (stay owned by the sub) and lists them in out.skipped_force_taken', async function() {
        var m = await tools();
        var files = [wsFile('a.js', 'sub1'), wsFile('taken.js', 'sub1', { force_taken_from: 'otherChat' }), wsFile('b.js', 'other')];
        var writes = armWs(m, files);
        var out = {};
        var n = await m._wsTransferOwnership('sub1', 'root1', out);
        assert.strictEqual(n, 1, 'still returns the transferred count');
        assert.deepStrictEqual(writes, ['a.js']);
        assert.deepStrictEqual(out.skipped_force_taken, ['taken.js']);
        assert.strictEqual(files[0].last_modified_by_chat_id, 'root1');
        assert.strictEqual(files[1].last_modified_by_chat_id, 'sub1', 'force-taken row NOT handed to root');
        assert.strictEqual(files[1].force_taken_from, 'otherChat', 'marker preserved for status/push warnings');
        assert.strictEqual(await m._wsTransferOwnership('sub1', 'root1'), 0, 'no out param → still works');
    });
    test('#3 wiring: stamp sites carry force_taken_from; push + discard clear it; 097 records skipped paths', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        // B11: all three stamp sites route through _wsNextForceTakenFrom (new takeover wins, reclaim by the taken-from lineage clears, else carried)
        assert.ok(/force_taken_from: _isDirty \? _wsNextForceTakenFrom\(_wWriteDecision, existing && existing\.force_taken_from, chatId\)/.test(src), 'wsWrite stamps');
        assert.ok(/file\.force_taken_from = _wsNextForceTakenFrom\(_wEditDecision, file\.force_taken_from, chatId\)/.test(src), 'wsEdit stamps');
        assert.ok(/file\.force_taken_from = _wsNextForceTakenFrom\(_wDelDecision, file\.force_taken_from, chatId\)/.test(src), 'wsDelete stamps');
        assert.ok(/dirtyFiles\[k\]\.force_taken_from = null;/.test(src), 'push release clears');
        assert.ok(/f\.force_taken_from = null;/.test(src), 'discard clears');
        var reg = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok(/_wsTransferOwnership\(rec\.chat_id, rec\.root_chat_id \|\| rec\.parent_chat_id \|\| null, out\)/.test(reg));
        assert.ok(/function _subNoteForceTaken\(rec, paths\)/.test(reg));
        assert.ok(/e\.workspace_force_taken = rec\.workspace_force_taken/.test(reg), 'agent_status exposes it');
    });

    // ---- 4 -------------------------------------------------------------
    test('#4 wsPush: stale-branch (exists remotely, no open PR) + missing pr_title hard-fails before any reset; no auto-title on that path', async function() {
        var src = await loadFile('src/js/tools/020-tool-execution.js');
        var i = src.indexOf('if (!openPrForBranch && !args.pr_title) {');
        assert.ok(i > 0);
        var seg = src.slice(i, i + 1800);
        assert.ok(/if \(staleBranchRecreated\) \{[\s\S]*?return \{ success: false, error: 'branch "' \+ args\.branch_name \+ '" exists remotely but has no open PR/.test(seg), 'hard-fail message');
        assert.ok(!/args\.pr_title = _wsDefaultPrTitle/.test(seg), 'auto-title removed from the force-reset path');
        assert.ok(!/_prTitleDefaulted = true/.test(seg), 'flag never set on that path');
        // The reset (base head resolution) happens strictly AFTER the gate.
        var gate = src.indexOf("exists remotely but has no open PR");
        var reset = src.indexOf('if (!branchExists || staleBranchRecreated) {', i);
        assert.ok(gate > 0 && reset > gate, 'gate precedes the reset block');
    });

    // ---- 6 -------------------------------------------------------------
    test('#6 executeToolWithInterrupt: a throwing tool arm resolves to {success:false,error,tool_threw} instead of rejecting', async function() {
        var m = await loadModules(['src/js/app/030-agent-loop.js'], { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome() } });
        m.__scope.interruptResolversByChatId = {};
        m.__scope.userInterruptedChats = {};
        m.__scope.executeTool = async function() { throw new ReferenceError('executeRunTests is not defined'); };
        var r = await m.executeToolWithInterrupt('c1', 'run_tests', {}, 0, {});
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.tool_threw, true);
        assert.match(r.error, /executeRunTests is not defined/);
        m.__scope.executeTool = function() { throw new Error('sync boom'); };
        var r2 = await m.executeToolWithInterrupt(null, 'x', {}, 0, {});
        assert.strictEqual(r2.success, false); assert.match(r2.error, /sync boom/);
        m.__scope.executeTool = async function() { return { success: true, ok: 1 }; };
        var r3 = await m.executeToolWithInterrupt('c1', 'x', {}, 0, {});
        assert.strictEqual(r3.ok, 1, 'normal results pass through');
    });
});
