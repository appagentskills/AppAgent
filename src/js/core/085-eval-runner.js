// ─── eval_runner: built-in grader for the servicenow-eval skill ──────
// Lives in core (immutable at runtime — changes require a rebuild + user
// Reload) so the graded agent cannot hot-swap the grader the way it could
// a skill JS tool. All access to tasks.md (setup/verifier/cleanup scripts)
// happens HERE, never in model context. Verification is single-use and
// every verdict is persisted server-side to an audit property.

var EVAL_RUNNER_RUNS_PROP = 'x_eval.session.runs';
var EVAL_RUNNER_RESULTS_PROP = 'x_eval.session.results';
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
                "upsert('" + EVAL_RUNNER_RUNS_PROP + "', '{}');\n" +
                "upsert('" + EVAL_RUNNER_RESULTS_PROP + "', '{}');\n" +
                "gs.print(JSON.stringify({session: 'reset'}));",
                'Eval grader: resetting session', options, evalInstance);
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
            var setupScript =
                "var pName = '" + EVAL_RUNNER_RUNS_PROP + "';\n" +
                "var gr = new GlideRecord('sys_properties');\n" +
                "var runs = {};\n" +
                "var found = gr.get('name', pName);\n" +
                "if (found) { try { runs = JSON.parse(gr.value + '') || {}; } catch(e) {} }\n" +
                "else { gr.initialize(); gr.name = pName; }\n" +
                "var taskId = '" + task.id + "';\n" +
                "var st = runs[taskId] || {};\n" +
                "if (st.setup) {\n" +
                "  gs.print(JSON.stringify({error: 'DUPLICATE_SETUP', message: 'Setup already run for ' + taskId}));\n" +
                "} else {\n" +
                "  st.setup = 1; runs[taskId] = st;\n" +
                "  gr.value = JSON.stringify(runs);\n" +
                "  if (found) { gr.update(); } else { gr.insert(); }\n" +
                "  (function() {\n" + (task.setup_script || "gs.print('ready');") + "\n  })();\n" +
                "}";
            var setupOut = await evalRunnerRunScript(setupScript, 'Eval grader: setup ' + task.id, options, evalInstance);
            if (setupOut && setupOut.error === 'DUPLICATE_SETUP') {
                return { success: true, task_id: task.id, error: 'DUPLICATE_SETUP', cheated: true };
            }
            return { success: true, task_id: task.id, setup_output: setupOut };
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
            var verifyScript =
                "var pName = '" + EVAL_RUNNER_RUNS_PROP + "';\n" +
                "var gr = new GlideRecord('sys_properties');\n" +
                "var runs = {};\n" +
                "var found = gr.get('name', pName);\n" +
                "if (found) { try { runs = JSON.parse(gr.value + '') || {}; } catch(e) {} }\n" +
                "var taskId = '" + task2.id + "';\n" +
                "var st = runs[taskId] || {};\n" +
                "if (st.verified) {\n" +
                "  gs.print(JSON.stringify({pass: false, expected: '', actual: 'ALREADY_VERIFIED: single-use verification for ' + taskId}));\n" +
                "} else {\n" +
                "  // SINGLE-USE: mark verified BEFORE executing the verifier\n" +
                "  st.verified = 1; runs[taskId] = st;\n" +
                "  if (found) { gr.value = JSON.stringify(runs); gr.update(); }\n" +
                "  else { gr.initialize(); gr.name = pName; gr.value = JSON.stringify(runs); gr.insert(); }\n" +
                (pre ? "  gs.sleep(" + pre + ");\n" : "") +
                "  var __verifier_out = JSON.stringify({pass:false, expected:'', actual:'verifier produced no output'});\n" +
                "  function __emit(__x){ __verifier_out = String(__x); }\n" +
                "  try {\n" +
                "    var __ret = (function() {\n" + __vscript + "\n    })();\n" +
                "    if (__ret !== undefined && __ret !== null && String(__ret).length) { __verifier_out = String(__ret); }\n" +
                "  } catch (e) {\n" +
                "    __verifier_out = JSON.stringify({pass: false, expected: '', actual: 'Error during verification: ' + e.message});\n" +
                "  }\n" +
                "  try {\n" +
                "    (function() {\n" + (task2.cleanup_script || '') + "\n    })();\n" +
                "  } catch (e2) { /* cleanup errors ignored */ }\n" +
                "  // AUDIT TRAIL: persist verdict server-side in the same execution\n" +
                "  try {\n" +
                "    var verdict;\n" +
                "    try { verdict = JSON.parse(__verifier_out); } catch (e3) { verdict = {pass: false, expected: '', actual: 'unparseable verifier output'}; }\n" +
                "    var slim = {pass: !!verdict.pass,\n" +
                "                expected: String(verdict.expected === undefined ? '' : verdict.expected).slice(0, 60),\n" +
                "                actual: String(verdict.actual === undefined ? '' : verdict.actual).slice(0, 60)};\n" +
                "    var agr = new GlideRecord('sys_properties');\n" +
                "    var afound = agr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "');\n" +
                "    var audit = {};\n" +
                "    if (afound) { try { audit = JSON.parse(agr.value + '') || {}; } catch(e4) {} }\n" +
                "    else { agr.initialize(); agr.name = '" + EVAL_RUNNER_RESULTS_PROP + "'; }\n" +
                "    audit[taskId] = slim;\n" +
                "    agr.value = JSON.stringify(audit);\n" +
                "    if (afound) { agr.update(); } else { agr.insert(); }\n" +
                "  } catch (e5) { /* audit failure must not mask the verdict */ }\n" +
                "  gs.print(__verifier_out);\n" +
                "}";
            var verdictOut = await evalRunnerRunScript(verifyScript, 'Eval grader: verify+cleanup ' + task2.id, options, evalInstance);
            if (verdictOut && typeof verdictOut.pass !== 'undefined') {
                return {
                    success: true,
                    task_id: task2.id,
                    pass: !!verdictOut.pass,
                    expected: String(verdictOut.expected === undefined ? '' : verdictOut.expected),
                    actual: String(verdictOut.actual === undefined ? '' : verdictOut.actual)
                };
            }
            return { success: true, task_id: task2.id, pass: false, expected: '', actual: 'UNPARSEABLE: ' + JSON.stringify(verdictOut).slice(0, 200) };
        }

        if (action === 'teardown') {
            var tdOut = await evalRunnerRunScript(
                "var out = {audit: {}};\n" +
                "var agr = new GlideRecord('sys_properties');\n" +
                "if (agr.get('name', '" + EVAL_RUNNER_RESULTS_PROP + "')) { try { out.audit = JSON.parse(agr.value + ''); } catch(e) {} }\n" +
                "var d = new GlideRecord('sys_properties');\n" +
                "var q = d.addQuery('name', '" + EVAL_RUNNER_RUNS_PROP + "');\n" +
                "q.addOrCondition('name', '" + EVAL_RUNNER_RESULTS_PROP + "');\n" +
                "d.query();\n" +
                "var n = 0; while (d.next()) { d.deleteRecord(); n++; }\n" +
                "out.deleted = n;\n" +
                "gs.print(JSON.stringify(out));",
                'Eval grader: teardown + audit readout', options, evalInstance);
            return { success: true, audit: tdOut.audit || tdOut, deleted: tdOut.deleted };
        }

        return { success: false, error: 'unknown action: ' + (action || '(none)') };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
