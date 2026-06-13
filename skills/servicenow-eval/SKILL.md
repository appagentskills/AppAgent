---
name: servicenow-eval
description: "Evaluate whether the current model can perform 20 representative ServiceNow tasks (read, write, link, debug, batch, business rule, ACL, role, widget, attachment, logs, queue, UI action, client script, notification, aggregate, choice, table, scheduled job, dot-walk). Sets up seeded data, runs the model on each task, programmatically verifies the end state, cleans up, and produces a score."
actions:
  - name: Run ServiceNow Eval
    icon: stats
    show: [home]
---
# ServiceNow Eval (v4)

A 20-task evaluation suite that scores whether the current model can perform representative ServiceNow operations. Each task is deterministically graded by a server-side verifier that inspects the actual end state of the instance — the model cannot self-score.

**v4 integrity model:** all grading runs through the `eval_runner` tool, which is a BUILT-IN extension tool (src/js/core/085-eval-runner.js), not a skill file — its running copy is fixed at build time and cannot be modified at runtime; changes require a rebuild and a user-clicked Reload. The tool — not the agent — reads `tasks.md`, seeds tasks, executes verifiers and cleanup atomically server-side, enforces single-use verification, and writes every verdict to a server-side audit property. Verifier text never enters model context on any legitimate path. The agent only ever sees prompts and verdicts.

## Tasks (45 points total)

| ID | Category | Points | What it tests |
|----|----------|--------|---------------|
| T1 | read | 1 | Counting records, writing a sys_property answer |
| T2 | write | 2 | Creating a record with specific fields |
| T3 | link | 2 | Multi-record + reference fields (problem_id) |
| T4 | debug | 3 | Reading & fixing a broken script include |
| T5 | batch | 3 | Iterating + updating multiple records consistently |
| T6 | business_rule | 3 | Creating a before-insert BR with a mutation script |
| T7 | acl | 3 | Field-level ACL + role linkage (needs security_admin elevation) |
| T8 | role | 1 | sys_user_role creation |
| T9 | widget | 3 | sp_widget with correct template + CSS + server script |
| T10 | attachment | 3 | Writing exact text bytes via attachment API / GlideSysAttachment |
| T11 | logs | 2 | Filtering noisy syslog for a marker, extracting a UUID |
| T12 | queue | 2 | Clearing seeded sys_email outbound queue entries |
| T13 | ui_action | 2 | sys_ui_action with the right show/form flags |
| T14 | client_script | 2 | onChange client script on a specific field |
| T15 | notification | 2 | sysevent_email_action with subject/body markers |
| T16 | aggregate | 3 | GlideAggregate grouping by category, JSON result |
| T17 | choice | 1 | sys_choice entry for a field |
| T18 | table | 3 | Custom table extending task + custom field (sys_db_object + sys_dictionary) |
| T19 | scheduled_job | 2 | sysauto_script (inactive) with marker script |
| T20 | dot_walk | 2 | GlideRecord dot-walking through caller_id.department.name |

Each task uses a system property `x_eval.taskN.result` as the answer slot (where applicable). The verifier compares that property AND the actual record state to expected values.

## Files

- `tasks.md` — all 20 task specs (prompt, setup_script, verifier_script, cleanup_script). **OFF-LIMITS to the agent.** Only the `eval_runner` tool may read it (via the internal skills store); an agent-side `get_skill read_file` of tasks.md during a run is cheating.

The grader itself (`eval_runner`) is a built-in extension tool — see src/js/core/085-eval-runner.js. It is not a skill file and cannot be edited or hot-swapped at runtime.

## The eval_runner tool

| Call | Returns | Notes |
|------|---------|-------|
| `eval_runner({action:"init"})` | `{version, total_points, tasks:[{id,name,category,points,prompt}]}` | Resets session state (`x_eval.session.runs`, `x_eval.session.results`). |
| `eval_runner({action:"setup", task_id:"Tn"})` | `{task_id, setup_output}` or `{error:"DUPLICATE_SETUP", cheated:true}` | Duplicate-locked server-side; a second setup for the same task is refused. |
| `eval_runner({action:"verify", task_id:"Tn"})` | `{task_id, pass, expected, actual}` | SINGLE-USE: marks the task verified before executing; runs verifier + cleanup atomically in one server execution; persists the verdict to the audit property. A second verify returns `ALREADY_VERIFIED` (pass=false). Cache-settle sleeps for artifact-creating tasks (T6/T7/T18) are built into the tool — the agent never adds sleeps. |
| `eval_runner({action:"teardown"})` | `{audit: {Tn: {pass,expected,actual}}, deleted}` | Reads back the server-side audit verdicts, then deletes all session state. Call ONCE, after all 20 verifies. |

## Action Lifecycle: Run ServiceNow Eval

### 1. Initialize
- Call `update_action_state` with state=running, icon=stats, label="Running ServiceNow eval", and a tasks array with 20 pending items: `"T1: read"`, `"T2: write"`, ..., `"T20: dot_walk"`.
- Call `eval_runner({action:"init"})` and keep the returned `tasks` list (prompts + points).

### 2. For each task in order (T1 → T20):

   **a. Mark running.** Update the progress card (this task status="running"); record `t0 = Date.now()`.

   **b. Setup.** Call `eval_runner({action:"setup", task_id})`. If it returns `DUPLICATE_SETUP`, record 0 points, mark the task cheated, and do NOT attempt or verify it (the verify would burn anyway). If the setup output looks like a hard error, mark the task "setup failed", skip the attempt, but STILL call verify (it performs the cleanup).

   **c. Attempt.** Read the task's `prompt` and do the work with your normal tools: `servicenow_api` for CRUD, `servicenow_diff_edit` for in-place script edits, `servicenow_run_script` for server-only APIs (GlideSysAttachment, GlideAggregate, TableUtils, etc.). All writes use `confirm: false` — the user consented by clicking the button. For T7 (ACL): elevate to `security_admin` first via the elevate-security-role skill, and after clicking the role checkbox VERIFY it with `get_properties` (`checked: true`) before clicking OK — the input is a 1×1px overlay and clicks can silently miss; re-click via `dispatch_event` if needed. Some tasks intentionally collide with OOB engines and validation rules; diagnosing and working around them server-side DURING the attempt is legitimate and part of the test. Do not expect this skill to tell you the answers — figuring them out is what is being scored.

   **d. Verify.** Call `eval_runner({action:"verify", task_id})` → `{pass, expected, actual}`. `pass=true` earns full points; anything else earns 0. This is single-use and also runs cleanup — there is nothing to retry afterwards.

   **e. Record.** Push `{id, name, category, points, points_earned, pass, expected, actual, duration_ms: Date.now() - t0}` to a `results` array.

   **f. Mark done.** Progress card: status="done" if pass, "error" if not.

### 3. Teardown & cross-check
- Call `eval_runner({action:"teardown"})` and use the returned `audit` object.
- The scoreboard MUST be built from this server-side audit. Cross-check it against your in-memory `results`: every pass/fail must match. Any discrepancy must be disclosed explicitly in the final output — never silently reconciled.

### 4. Compute score
- `total_points_earned` = sum of points for audit-confirmed passes; `total_points = 45`.
- `score_pct = total_points_earned / total_points * 100` (1 decimal); `passed` = count of pass=true (out of 20).

### 5. Render scoreboard
Call the `display` tool TWICE:

**First** — `template: "status_summary"`, items:
- `{label: "Score", count: "${earned}/${total}", color: "blue"}`
- `{label: "Passed", count: passed, color: "green"}`
- `{label: "Failed", count: 20 - passed, color: "red"}`
- `{label: "Total time", count: "${seconds}s"}` (sum of duration_ms — measured, not estimated)

**Second** — `template: "table"`, columns: `["#", "Task", "Category", "Pts", "Result", "Detail", "Time"]`, one row per task. Result shows "✅ pass" or "❌ fail"; Detail shows `expected → actual` truncated to ~80 chars; Time from duration_ms.

### 6. Finalize
Call `update_action_state` with:
- `state: "done"` (or "error" if score_pct < 50)
- `output`: short markdown summary with the score, passed/failed count, audit cross-check status, and the 1-3 most surprising failures.
- `tasks`: full final array with all statuses.

## Rules

- **ALL GRADING GOES THROUGH eval_runner.** The agent must never read `tasks.md` (any phase, any reason), never run setup/verifier/cleanup logic itself, and never touch `x_eval.session.*` properties directly. Doing any of these is cheating and is visible in the transcript and in `sys_script_execution_history`.
- **STRICT SINGLE-PASS EVALUATION**: never retry a task or rerun its setup once attempted, regardless of verification outcome. The tool enforces this server-side (`DUPLICATE_SETUP`, `ALREADY_VERIFIED`) — but the rule stands even if enforcement fails.
- **NO POST-VERIFICATION MODIFICATIONS**: verify also cleans up; task assets are gone. Modifying anything after verification is forbidden.
- **NO SCORE FABRICATION / AUDIT IS AUTHORITATIVE**: the scoreboard is built from teardown's `audit` object and must match the per-task verdicts exactly. Editing the audit property outside the grader is severe cheating.
- **FAIL LOUDLY — never end silent.** The action must ALWAYS terminate with an `update_action_state` of state=done or state=error whose `output` states the score — or states explicitly that nothing (or only part of the run) was executed on the instance. If `eval_runner init` fails, immediately set state=error with output "Nothing has run on the instance" plus the error. If the run aborts midway, the output must say how many tasks were set up/verified and that the surviving verdicts are in `x_eval.session.results` / `sys_script_execution_history`.
- Attempts use the same tools and patterns you would for a real user request — that's the point.
- **Crash recovery without re-running**: verdicts already produced survive in the `x_eval.session.results` property (read it via Table API) and in `sys_script_execution_history` (field `result`, HTML-escaped). Never re-verify (it would return ALREADY_VERIFIED anyway), and never read the `script` field of grader executions for tasks not yet attempted.
