// ─── eval_runner: built-in grader for the servicenow-eval skill ──────
// Lives in core (immutable at runtime — changes require a rebuild + user
// Reload) so the graded agent cannot hot-swap the grader the way it could
// a skill JS tool. All access to tasks.md (setup/verifier/cleanup scripts)
// happens HERE, never in model context. Verification is single-use and
// every verdict is persisted server-side to an audit property.

// Lock state lives in ONE property PER TASK ('<runs prop>.<task id>') so
// concurrent eval_runner calls for different tasks never read-modify-write
// the same shared row and cannot clobber each other's setup/verified flags.
var EVAL_RUNNER_RUNS_PROP = 'x_eval.session.runs';
var EVAL_RUNNER_RESULTS_PROP = 'x_eval.session.results';
// FIX B: durable end-of-run audit snapshot. teardown copies the results
// audit here BEFORE deleting results, so a transparent sys.scripts.do GET
// retry replays the SAME audit instead of an empty one. init clears it too.
var EVAL_RUNNER_AUDIT_FINAL_PROP = 'x_eval.session.audit_final';
// Cache-settle sleeps for tasks creating server-side executable artifacts.
// Decided here at build time — never by the agent, never after a verdict.
var EVAL_RUNNER_PRE_SLEEP_MS = { T6: 2000, T7: 2000, T18: 2000 };

function evalRunnerParseScriptResult(res) {
    // Surface tool-level failures (arg validation, auth, fetch errors) instead
    // of collapsing them into an empty {_raw:""} — without this, a rejected
    // servicenow_run_script call (e.g. missing required `instance` under
    // deferred-mode arg validation) looked like an empty script output and
    // every verdict came back UNPARSEABLE with no clue why.
    if (res && res.success === false && res.error) {
        return { _error: String(res.error).slice(0, 300) };
    }
    var raw = ((res && (res.output || (res.result && res.result.output))) || '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");
    var lines = raw.split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
        var m = lines[i].match(/\*\*\* Script:\s*(.*)$/);
        if (!m) continue;
        var t = m[1].trim();
        if (t.charAt(0) === '{') {
            try { return JSON.parse(t); } catch (_) { continue; }
        }
        return { _marker: t };
    }
    return { _raw: raw.slice(-400) };
}

async function evalRunnerRunScript(script, msg, options, instance) {
    // servicenow_run_script's schema REQUIRES `instance` — deferred-mode arg
    // validation (tools/020-tool-execution.js → validateArgsAgainstToolSchema)
    // rejects the call outright when it is missing, and the legacy no-instance
    // relative-URL fallback doesn't work from the service worker anyway.
    // Resolve explicitly: caller-supplied value first, then the active
    // instance URL (Platform.resolveInstanceUrl accepts full URLs too).
    var callArgs = {
        script: script,
        confirm: false,
        status_message: msg
    };
    var inst = instance
        || (typeof Platform !== 'undefined' && Platform.instanceUrl) || null;
    if (inst) callArgs.instance = inst;
    var res = await executeTool('servicenow_run_script', callArgs, null, {
        chatId: options && options.chatId,
        fromSandbox: true,
        parentToolCallId: options && options.toolCallId
    });
    return evalRunnerParseScriptResult(res);
}

async function evalRunnerLoadSpec() {
    var asset = await getSkillAsset('servicenow-eval', 'tasks.md');
    if (!asset || !asset.content) throw new Error('servicenow-eval/tasks.md not found in skills store');
    var m = asset.content.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('tasks.md: no fenced json block found');
    return JSON.parse(m[1]);
}

function evalRunnerGetTask(spec, id) {
    for (var i = 0; i < spec.tasks.length; i++) {
        if (spec.tasks[i].id === id) return spec.tasks[i];
    }
    return null;
}

async function executeEvalRunner(args, options) {
    try {
        var action = args && args.action;
        // Optional explicit target instance (short name or URL); defaults to
        // the active instance inside evalRunnerRunScript.
        var evalInstance = (args && args.instance) || null;

        if (action === 'init') {
            var spec = await evalRunnerLoadSpec();
            var initOut = await evalRunnerRunScript(
                "function upsert(name, val) {\n" +
                "  var gr = new GlideRecord('sys_properties');\n" +
                "  if (gr.get('name', name)) { gr.value = val; gr.update(); }\n" +
                "  else { gr.initialize(); gr.name = name; gr.value = val; gr.insert(); }\n" +
                "}\n" +
                // FIX (a): clear runs*/locks + the durable audit snapshot, then READ
                // BACK to confirm ZERO setup locks survive. Retry the clear ONCE and
                // report locks_remaining so the tool can fail loudly — a prior run's
                // persisted x_eval.session.runs.* locks would otherwise brand a
                // task's first-ever setup DUPLICATE_SETUP/cheated.
                "function clearRuns() {\n" +
                "  var od = new GlideRecord('sys_properties');\n" +
                "  var oq = od.addQuery('name', 'STARTSWITH', '" + EVAL_RUNNER_RUNS_PROP + "');\n" +
                "  oq.addOrCondition('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "');\n" +
                "  od.query();\n" +
                "  var n = 0; while (od.next()) { od.deleteRecord(); n++; }\n" +
                "  return n;\n" +
                "}\n" +
                "function countLocks() {\n" +
                "  var cq = new GlideRecord('sys_properties');\n" +
                "  cq.addQuery('name', 'STARTSWITH', '" + EVAL_RUNNER_RUNS_PROP + "');\n" +
                "  cq.query();\n" +
                "  var c = 0; while (cq.next()) c++;\n" +
                "  return c;\n" +
                "}\n" +
                "var locks_deleted = clearRuns();\n" +
                "var locks_remaining = countLocks();\n" +
                "var retried_clear = false;\n" +
                "if (locks_remaining > 0) { retried_clear = true; clearRuns(); locks_remaining = countLocks(); }\n" +
                "upsert('" + EVAL_RUNNER_RESULTS_PROP + "', '{}');\n" +
                // FIX A: read the container BACK so the tool can CONFIRM it was
                // actually established before returning success (fail loudly otherwise).
                "var cgr = new GlideRecord('sys_properties');\n" +
                "var results_created = cgr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "') ? (cgr.value + '') : null;\n" +
                "gs.print(JSON.stringify({session: 'reset', results_created: results_created, locks_deleted: locks_deleted, locks_remaining: locks_remaining, retried_clear: retried_clear}));",
                'Eval grader: resetting session', options, evalInstance);
            // FIX A: fail loudly instead of silently succeeding. Only return
            // success when the session container is CONFIRMED created. A script-
            // execution denial (_error, or "Not authorized" in _raw) or a missing
            // container means the reset never took effect — return a retryable
            // structured failure (do NOT throw) so the agent can elevate
            // (security_admin) and retry the init CALL.
            var initDenied = !!(initOut && (initOut._error ||
                (typeof initOut._raw === 'string' && /Not authorized/i.test(initOut._raw))));
            var containerCreated = !!(initOut && typeof initOut.results_created === 'string');
            if (initDenied || !containerCreated) {
                return {
                    success: false,
                    error: 'INIT_FAILED',
                    retryable: true,
                    detail: (initOut && (initOut._error || initOut._raw)) || initOut
                };
            }
            // FIX (a): even a "successful" reset must leave ZERO setup locks. The
            // server script already retried the clear once; if any remain, refuse
            // to start rather than brand a task's first-ever setup DUPLICATE_SETUP.
            var locksRemaining = (initOut && typeof initOut.locks_remaining === 'number') ? initOut.locks_remaining : 0;
            if (locksRemaining > 0) {
                return {
                    success: false,
                    error: 'INIT_FAILED',
                    retryable: true,
                    detail: 'stale setup locks not cleared (' + locksRemaining + ' remain after retry)'
                };
            }
            return {
                success: true,
                session: initOut,
                version: spec.version,
                total_points: spec.total_points,
                tasks: spec.tasks.map(function (t) {
                    return { id: t.id, name: t.name, category: t.category, points: t.points, prompt: t.prompt };
                })
            };
        }

        if (action === 'setup') {
            if (!args.task_id) return { success: false, error: 'task_id required' };
            var spec2 = await evalRunnerLoadSpec();
            var task = evalRunnerGetTask(spec2, args.task_id);
            if (!task) return { success: false, error: 'unknown task_id: ' + args.task_id };
            var setupLock = EVAL_RUNNER_RUNS_PROP + '.' + task.id;
            // FIX (b): capture the setup_script's OWN gs.print output via __emit
            // (same rewrite the verifier uses) so it can be stored server-side for
            // idempotent replay on a duplicate call.
            var setupBody = (task.setup_script || "gs.print('ready');").replace(/gs\s*\.\s*print\s*\(/g, '__emit(');
            var setupScript =
                "var pName = '" + setupLock + "';\n" +
                "var gr = new GlideRecord('sys_properties');\n" +
                "var st = {};\n" +
                "var found = gr.get('name', pName);\n" +
                "if (found) { try { st = JSON.parse(gr.value + '') || {}; } catch(e) {} }\n" +
                "if (st.setup) {\n" +
                "  // FIX (b): a duplicate setup for a NOT-yet-verified task replays the\n" +
                "  // stored setup_output (replayed:true) WITHOUT re-seeding — zero cheat\n" +
                "  // advantage — so an innocent lost-response retry is not branded\n" +
                "  // cheated. Only an already-verified task, or one with no stored\n" +
                "  // output to replay, stays DUPLICATE_SETUP/cheated.\n" +
                "  if (st.verified) {\n" +
                "    gs.print(JSON.stringify({error: 'DUPLICATE_SETUP', message: 'Setup already run and task already verified for " + task.id + "'}));\n" +
                "  } else if (typeof st.setup_output === 'string' && st.setup_output.length) {\n" +
                "    st.replays = (st.replays || 0) + 1;\n" +
                "    try { gr.value = JSON.stringify(st); gr.update(); } catch (eRc) {}\n" +
                "    var replayObj;\n" +
                "    try { replayObj = JSON.parse(st.setup_output) || {}; } catch (ePr) { replayObj = {_raw: st.setup_output}; }\n" +
                "    replayObj.replayed = true;\n" +
                "    replayObj.replays = st.replays;\n" +
                "    gs.print(JSON.stringify(replayObj));\n" +
                "  } else {\n" +
                "    gs.print(JSON.stringify({error: 'DUPLICATE_SETUP', message: 'Setup already run for " + task.id + " (no stored output to replay)'}));\n" +
                "  }\n" +
                "} else {\n" +
                "  st.setup = 1;\n" +
                "  if (found) { gr.value = JSON.stringify(st); gr.update(); }\n" +
                "  else { gr.initialize(); gr.name = pName; gr.value = JSON.stringify(st); gr.insert(); }\n" +
                "  var __setupSentinel = JSON.stringify({_marker: 'ready'});\n" +
                "  var __setup_out = __setupSentinel;\n" +
                "  function __emit(__x){ __setup_out = String(__x); }\n" +
                "  var __setupFailed = false;\n" +
                "  try {\n" +
                "    var __sret = (function() {\n" + setupBody + "\n    })();\n" +
                "    if (__setup_out === __setupSentinel && __sret !== undefined && __sret !== null && String(__sret).length) { __setup_out = String(__sret); }\n" +
                "  } catch (eS) {\n" +
                "    // Roll back the lock: a THROWING setup must stay retryable instead\n" +
                "    // of branding the next attempt DUPLICATE_SETUP/cheated.\n" +
                "    try { delete st.setup; gr.value = JSON.stringify(st); gr.update(); } catch (eRb) {}\n" +
                "    __setupFailed = true;\n" +
                "    gs.print(JSON.stringify({error: 'SETUP_FAILED', message: String((eS && eS.message) || eS).slice(0, 200)}));\n" +
                "  }\n" +
                "  if (!__setupFailed) {\n" +
                "    // FIX (b)+(c): store setup_output durably, then READ BACK in the\n" +
                "    // same execution (GlideRecord, not the gs.getProperty cache); retry\n" +
                "    // the write once if the read-back does not match.\n" +
                "    st.setup_output = __setup_out;\n" +
                "    try { gr.value = JSON.stringify(st); gr.update(); } catch (eStore) {}\n" +
                "    var __persistedS = false;\n" +
                "    try {\n" +
                "      var vgr = new GlideRecord('sys_properties');\n" +
                "      if (vgr.get('name', pName)) { var vst = JSON.parse(vgr.value + '') || {}; __persistedS = (vst.setup_output === __setup_out); }\n" +
                "    } catch (eV) {}\n" +
                "    if (!__persistedS) { try { gr.value = JSON.stringify(st); gr.update(); } catch (eR2) {} }\n" +
                "    gs.print(__setup_out);\n" +
                "  }\n" +
                "}";
            var setupOut = await evalRunnerRunScript(setupScript, 'Eval grader: setup ' + task.id, options, evalInstance);
            if (setupOut && setupOut._error) {
                // Tool/client-level failure: the server script never ran and the
                // setup lock was not taken — retryable, not a setup result.
                return { success: false, task_id: task.id, error: setupOut._error, retryable: true };
            }
            if (setupOut && setupOut.error === 'DUPLICATE_SETUP') {
                return { success: true, task_id: task.id, error: 'DUPLICATE_SETUP', cheated: true };
            }
            if (setupOut && setupOut.error === 'SETUP_FAILED') {
                return { success: false, task_id: task.id, error: 'SETUP_FAILED', message: setupOut.message, retryable: true };
            }
            // ANSWER-LEAK GUARD: never forward seeded expected values to the graded
            // model — redact any key that looks like an answer, and scrub _raw.
            if (setupOut && typeof setupOut === 'object') {
                for (var sk in setupOut) {
                    if (/expected|answer/i.test(sk)) delete setupOut[sk];
                }
                if (typeof setupOut._raw === 'string' && /expected|answer/i.test(setupOut._raw)) {
                    setupOut._raw = '[redacted: possible answer leak]';
                }
            }
            var setupResp = { success: true, task_id: task.id, setup_output: setupOut };
            // FIX (b): surface the idempotent-replay signal at the top level too, so
            // the harness can log a replay without inspecting setup_output.
            if (setupOut && setupOut.replayed) {
                setupResp.replayed = true;
                if (typeof setupOut.replays === 'number') setupResp.replays = setupOut.replays;
            }
            return setupResp;
        }

        if (action === 'verify') {
            if (!args.task_id) return { success: false, error: 'task_id required' };
            var spec3 = await evalRunnerLoadSpec();
            var task2 = evalRunnerGetTask(spec3, args.task_id);
            if (!task2) return { success: false, error: 'unknown task_id: ' + args.task_id };
            var pre = EVAL_RUNNER_PRE_SLEEP_MS[task2.id] || 0;
            // Verifier scripts EMIT their verdict via gs.print(JSON.stringify(...)),
            // they do NOT `return` it (same contract as setup_script). Rewrite
            // gs.print(...) -> __emit(...) so the wrapper captures the verdict into
            // __verifier_out. A verifier that `return`s a value is still honored via
            // the IIFE return as a fallback.
            var __vscript = (task2.verifier_script || "__emit(JSON.stringify({pass:false,expected:'',actual:'no verifier'}));");
            __vscript = __vscript.replace(/gs\s*\.\s*print\s*\(/g, '__emit(');
            var verifyLock = EVAL_RUNNER_RUNS_PROP + '.' + task2.id;
            var verifyScript =
                "var pName = '" + verifyLock + "';\n" +
                "var gr = new GlideRecord('sys_properties');\n" +
                "var st = {};\n" +
                "var found = gr.get('name', pName);\n" +
                "if (found) { try { st = JSON.parse(gr.value + '') || {}; } catch(e) {} }\n" +
                "var taskId = '" + task2.id + "';\n" +
                "if (st.verified) {\n" +
                "  // IDEMPOTENT REPLAY: sys.scripts.do is a GET — the network stack can\n" +
                "  // transparently retry it and re-execute this script after the first\n" +
                "  // run already verified (observed live on T11). Replay the recorded\n" +
                "  // verdict instead of returning a spurious ALREADY_VERIFIED fail.\n" +
                "  var rp = null;\n" +
                "  try {\n" +
                "    var rgr = new GlideRecord('sys_properties');\n" +
                "    if (rgr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "')) { rp = (JSON.parse(rgr.value + '') || {})[taskId] || null; }\n" +
                "  } catch (eRp) {}\n" +
                "  if (rp && typeof rp.pass !== 'undefined') {\n" +
                "    rp.replayed = true;\n" +
                "    rp.persisted = true; // read back from the durable results store = proof it persisted\n" +
                "    gs.print(JSON.stringify(rp));\n" +
                "  } else {\n" +
                "    gs.print(JSON.stringify({pass: false, expected: '', actual: 'ALREADY_VERIFIED: single-use verification for ' + taskId}));\n" +
                "  }\n" +
                "} else {\n" +
                "  // SINGLE-USE: mark verified BEFORE executing the verifier\n" +
                "  st.verified = 1;\n" +
                "  if (found) { gr.value = JSON.stringify(st); gr.update(); }\n" +
                "  else { gr.initialize(); gr.name = pName; gr.value = JSON.stringify(st); gr.insert(); }\n" +
                (pre ? "  gs.sleep(" + pre + ");\n" : "") +
                "  var __sentinel = JSON.stringify({pass:false, expected:'', actual:'verifier produced no output'});\n" +
                "  var __verifier_out = __sentinel;\n" +
                "  function __emit(__x){ __verifier_out = String(__x); }\n" +
                "  try {\n" +
                "    var __ret = (function() {\n" + __vscript + "\n    })();\n" +
                "    // Fallback ONLY: honor the IIFE return value when __emit captured\n" +
                "    // nothing — a verifier that both emits and returns must keep the\n" +
                "    // emitted verdict.\n" +
                "    if (__verifier_out === __sentinel && __ret !== undefined && __ret !== null && String(__ret).length) { __verifier_out = String(__ret); }\n" +
                "  } catch (e) {\n" +
                "    __verifier_out = JSON.stringify({pass: false, expected: '', actual: 'Error during verification: ' + e.message});\n" +
                "  }\n" +
                "  try {\n" +
                "    (function() {\n" + (task2.cleanup_script || '') + "\n    })();\n" +
                "  } catch (e2) { /* cleanup errors ignored */ }\n" +
                "  // AUDIT TRAIL (FIX c): persist verdict server-side in the SAME\n" +
                "  // execution, then READ IT BACK via GlideRecord (bypasses the\n" +
                "  // gs.getProperty cache). Retry the write once if the read-back does\n" +
                "  // not match, and stamp persisted:true|false onto the emitted verdict\n" +
                "  // so the client knows whether the audit durably landed.\n" +
                "  var __auditPersisted = false;\n" +
                "  var __verdictObj = null;\n" +
                "  try {\n" +
                "    var verdict;\n" +
                "    try { verdict = JSON.parse(__verifier_out); } catch (e3) { verdict = {pass: false, expected: '', actual: 'unparseable verifier output'}; }\n" +
                "    __verdictObj = verdict;\n" +
                "    var slim = {pass: !!verdict.pass,\n" +
                "                expected: String(verdict.expected === undefined ? '' : verdict.expected).slice(0, 60),\n" +
                "                actual: String(verdict.actual === undefined ? '' : verdict.actual).slice(0, 60)};\n" +
                "    var writeAudit = function () {\n" +
                "      var agr = new GlideRecord('sys_properties');\n" +
                "      var afound = agr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "');\n" +
                "      var audit = {};\n" +
                "      if (afound) { try { audit = JSON.parse(agr.value + '') || {}; } catch(e4) {} }\n" +
                "      else { agr.initialize(); agr.name = '" + EVAL_RUNNER_RESULTS_PROP + "'; }\n" +
                "      audit[taskId] = slim;\n" +
                "      agr.value = JSON.stringify(audit);\n" +
                "      if (afound) { agr.update(); } else { agr.insert(); }\n" +
                "    };\n" +
                "    var readBackAudit = function () {\n" +
                "      var vgr = new GlideRecord('sys_properties');\n" +
                "      if (!vgr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "')) return false;\n" +
                "      var a; try { a = JSON.parse(vgr.value + '') || {}; } catch (eRb) { return false; }\n" +
                "      var w = a[taskId];\n" +
                "      return !!(w && (!!w.pass) === slim.pass && String(w.actual) === String(slim.actual));\n" +
                "    };\n" +
                "    writeAudit();\n" +
                "    __auditPersisted = readBackAudit();\n" +
                "    if (!__auditPersisted) { writeAudit(); __auditPersisted = readBackAudit(); }\n" +
                "  } catch (e5) { /* audit failure must not mask the verdict */ }\n" +
                "  // Stamp persisted onto the emitted verdict (add field, keep shape).\n" +
                "  try {\n" +
                "    if (!__verdictObj) { __verdictObj = JSON.parse(__verifier_out); }\n" +
                "    __verdictObj.persisted = __auditPersisted;\n" +
                "    __verifier_out = JSON.stringify(__verdictObj);\n" +
                "  } catch (e6) { /* keep raw __verifier_out if it will not re-parse */ }\n" +
                "  gs.print(__verifier_out);\n" +
                "}";
            var verdictOut = await evalRunnerRunScript(verifyScript, 'Eval grader: verify+cleanup ' + task2.id, options, evalInstance);
            if (verdictOut && verdictOut._error) {
                // Tool/client-level failure: the verifier never executed server-side,
                // so the single-use lock was NOT burned — return a retryable error,
                // never a pass:false verdict.
                return { success: false, task_id: task2.id, error: verdictOut._error, retryable: true };
            }
            if (verdictOut && typeof verdictOut.pass !== 'undefined') {
                var vres = {
                    success: true,
                    task_id: task2.id,
                    pass: !!verdictOut.pass,
                    expected: String(verdictOut.expected === undefined ? '' : verdictOut.expected),
                    actual: String(verdictOut.actual === undefined ? '' : verdictOut.actual)
                };
                if (verdictOut.replayed) vres.replayed = true;
                if (typeof verdictOut.persisted !== 'undefined') vres.persisted = !!verdictOut.persisted;
                return vres;
            }
            return { success: true, task_id: task2.id, pass: false, expected: '', actual: 'UNPARSEABLE: ' + JSON.stringify(verdictOut).slice(0, 200) };
        }

        if (action === 'teardown') {
            // FIX B: make teardown IDEMPOTENT so a transparent sys.scripts.do GET
            // retry returns the SAME audit, never an empty one. The old script read
            // the audit and deleted it in the SAME execution, so a replay found
            // results already gone and returned {audit:{}, deleted:0}. Now the audit
            // is snapshotted to a durable property (audit_final) BEFORE deletion and
            // replayed from there on any subsequent run.
            var tdOut = await evalRunnerRunScript(
                "var out = {audit: {}, deleted: 0, replayed: false};\n" +
                // FIX (d): gather diagnostics BEFORE any deletion so an empty audit
                // can be told apart: nothing-ran (no locks, no results) vs writes-lost
                // (locks/results existed but the blob is empty). Per-lock setup/
                // verified/replays gives the replay-counter transparency.
                "var diag = {runs_rows: 0, locks: [], setup_replays_total: 0, results_exists: false, results_keys: 0, results_updated: null, audit_final_exists: false, audit_final_updated: null};\n" +
                "var dq = new GlideRecord('sys_properties');\n" +
                "dq.addQuery('name', 'STARTSWITH', '" + EVAL_RUNNER_RUNS_PROP + "');\n" +
                "dq.query();\n" +
                "while (dq.next()) {\n" +
                "  diag.runs_rows++;\n" +
                "  var rv = {}; try { rv = JSON.parse(dq.value + '') || {}; } catch (eRv) {}\n" +
                "  diag.setup_replays_total += (rv.replays || 0);\n" +
                "  if (diag.locks.length < 40) diag.locks.push({name: dq.getValue('name'), updated: dq.getValue('sys_updated_on'), setup: !!rv.setup, verified: !!rv.verified, replays: rv.replays || 0});\n" +
                "}\n" +
                "var rprobe = new GlideRecord('sys_properties');\n" +
                "if (rprobe.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "')) { diag.results_exists = true; diag.results_updated = rprobe.getValue('sys_updated_on'); try { diag.results_keys = Object.keys(JSON.parse(rprobe.value + '') || {}).length; } catch (eK) {} }\n" +
                "var aprobe = new GlideRecord('sys_properties');\n" +
                "if (aprobe.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) { diag.audit_final_exists = true; diag.audit_final_updated = aprobe.getValue('sys_updated_on'); }\n" +
                "var rgr = new GlideRecord('sys_properties');\n" +
                "if (rgr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "')) {\n" +
                "  // FIRST teardown: results still exist. Snapshot the audit to the\n" +
                "  // durable audit_final property BEFORE deleting runs*/results.\n" +
                "  var rawResults = rgr.value + '';\n" +
                "  try { out.audit = JSON.parse(rawResults) || {}; } catch (e) { out.audit = {}; }\n" +
                "  var sgr = new GlideRecord('sys_properties');\n" +
                "  if (sgr.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) { sgr.value = rawResults; sgr.update(); }\n" +
                "  else { sgr.initialize(); sgr.name = '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "'; sgr.value = rawResults; sgr.insert(); }\n" +
                "  // FIX (c): read the durable snapshot BACK; retry the write once if\n" +
                "  // it did not land, and report snapshot_persisted.\n" +
                "  var snapOK = false;\n" +
                "  var chk = new GlideRecord('sys_properties');\n" +
                "  if (chk.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) { snapOK = ((chk.value + '') === rawResults); }\n" +
                "  if (!snapOK) {\n" +
                "    var sgr2 = new GlideRecord('sys_properties');\n" +
                "    if (sgr2.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) { sgr2.value = rawResults; sgr2.update(); }\n" +
                "    else { sgr2.initialize(); sgr2.name = '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "'; sgr2.value = rawResults; sgr2.insert(); }\n" +
                "    var chk2 = new GlideRecord('sys_properties');\n" +
                "    if (chk2.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) { snapOK = ((chk2.value + '') === rawResults); }\n" +
                "  }\n" +
                "  out.snapshot_persisted = snapOK;\n" +
                "  var d = new GlideRecord('sys_properties');\n" +
                "  var q = d.addQuery('name', 'STARTSWITH', '" + EVAL_RUNNER_RUNS_PROP + "');\n" +
                "  q.addOrCondition('name', '" + EVAL_RUNNER_RESULTS_PROP + "');\n" +
                "  d.query();\n" +
                "  var n = 0; while (d.next()) { d.deleteRecord(); n++; }\n" +
                "  out.deleted = n;\n" +
                "} else {\n" +
                "  // RETRY: results already gone. Replay the durable snapshot so the\n" +
                "  // audit survives the GET retry instead of coming back empty.\n" +
                "  var fgr = new GlideRecord('sys_properties');\n" +
                "  if (fgr.get('name', '" + EVAL_RUNNER_AUDIT_FINAL_PROP + "')) {\n" +
                "    try { out.audit = JSON.parse(fgr.value + '') || {}; } catch (e) { out.audit = {}; }\n" +
                "    out.replayed = true;\n" +
                "  }\n" +
                "}\n" +
                "// FIX (d): when the resulting audit is EMPTY, attach diagnostics so an\n" +
                "// empty scoreboard can be attributed to nothing-ran vs writes-lost.\n" +
                "var auditEmpty = true; for (var __ek in out.audit) { auditEmpty = false; break; }\n" +
                "if (auditEmpty) out.diagnostics = diag;\n" +
                "gs.print(JSON.stringify(out));",
                'Eval grader: teardown + audit readout', options, evalInstance);
            // FIX B (mirrors the init guard ~L122): a script-exec DENIAL during
            // teardown must fail loudly too — otherwise teardown returns an empty
            // audit as if it "succeeded". Same detection shape as initDenied above.
            // A genuinely empty audit on a SUCCESSFUL teardown script (no _error/
            // _raw) is the legitimate INCONCLUSIVE case and still returns
            // success:true below — only a denial/error trips this guard.
            var tdDenied = !!(tdOut && (tdOut._error ||
                (typeof tdOut._raw === 'string' && /Not authorized/i.test(tdOut._raw))));
            if (tdDenied) {
                return {
                    success: false,
                    error: 'TEARDOWN_FAILED',
                    retryable: true,
                    detail: (tdOut && (tdOut._error || tdOut._raw)) || tdOut
                };
            }
            // Backward-compatible client shape: {success:true, audit, deleted} plus
            // the new `replayed` flag (true when the durable snapshot was replayed).
            var tdResp = {
                success: true,
                audit: (tdOut && tdOut.audit) || {},
                deleted: (tdOut && tdOut.deleted) || 0,
                replayed: !!(tdOut && tdOut.replayed)
            };
            if (tdOut && typeof tdOut.snapshot_persisted !== 'undefined') tdResp.snapshot_persisted = !!tdOut.snapshot_persisted;
            // FIX (d): surface diagnostics when the audit came back empty.
            if (tdOut && tdOut.diagnostics) tdResp.diagnostics = tdOut.diagnostics;
            return tdResp;
        }

        return { success: false, error: 'unknown action: ' + (action || '(none)') };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
