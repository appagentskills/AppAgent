---
name: servicenow-eval
description: "Evaluate whether the current model can perform 20 representative ServiceNow tasks (read, write, link, debug, batch, business rule, ACL, role, widget, attachment, logs, queue, UI action, client script, notification, aggregate, choice, table, scheduled job, dot-walk). Sets up seeded data, runs the model on each task, programmatically verifies the end state, cleans up, and produces a score."
actions:
  - name: Run ServiceNow Eval
    icon: stats
    show: [home]
---
# ServiceNow Eval (v2)

A 20-task evaluation suite that scores whether the current model can perform representative ServiceNow operations. Each task is deterministically graded by a server-side verifier that inspects the actual end state of the instance — the model cannot self-score.

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

- `tasks.md` — all 20 task specs (prompt, setup_script, verifier_script, cleanup_script), stored as a fenced ```json``` block. Parse with: `JSON.parse(content.match(/```json\n([\s\S]+?)\n```/)[1])`.

## Action Lifecycle: Run ServiceNow Eval

This action runs all 20 tasks end-to-end and produces a scoreboard.

### 1. Initialize progress & Session
- Call `update_action_state` with state=running, icon=stats, label="Running ServiceNow eval", and a tasks array with 20 pending items: `"T1: read"`, `"T2: write"`, ..., `"T20: dot_walk"`.
- Initialize/Clear the tracking property `x_eval.session.runs` on the ServiceNow instance to ensure a clean evaluation state. Call `servicenow_run_script` with `confirm: false` and script:
```js
var gr = new GlideRecord('sys_properties');
if (gr.get('name', 'x_eval.session.runs')) {
  gr.value = '{}';
  gr.update();
} else {
  gr.initialize();
  gr.name = 'x_eval.session.runs';
  gr.value = '{}';
  gr.insert();
}
```

### 2. Load task specs
Call `get_skill` with action="read_file", filename="tasks.md", skill_id="servicenow-eval". Extract the JSON from the fenced ```json``` block and `JSON.parse` it. You now have `{version, total_points, tasks}` where `tasks` is the array of 20.

### 3. Helper: parsing server-script output

`servicenow_run_script` returns output that is HTML-escaped and prefixed with log noise. The verifier line looks like `*** Script: {&quot;pass&quot;:true,...}`. Use this helper:

```js
function parseScriptResult(res) {
  const raw = ((res && (res.output || res.result?.output)) || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\*\*\* Script:\s*(\{.*\})\s*$/);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) { /* keep looking */ }
    }
  }
  return { _raw: raw };
}
```

Use this for setup output (e.g. `{expected_count: 4}`) and verifier output (`{pass, expected, actual}`).

### 4. For each task in order (T1 → T20):

   **a. Mark running.** Update the progress card: this task's status="running", previous tasks keep their status. Set status_message to e.g. "Running T6: business_rule".

   **b. Setup & Duplicate Prevention.** Call `servicenow_run_script` with a script that first checks and increments the setup execution lock in `x_eval.session.runs`. If `setup_script` has been run before for this task, fail immediately to prevent retries (cheating). Use `confirm: false`. Run this wrapper script utilizing the individual task's `setup_script` code:
```js
var pName = 'x_eval.session.runs';
var gr = new GlideRecord('sys_properties');
var runs = {};
if (gr.get('name', pName)) {
  try { runs = JSON.parse(gr.value + '') || {}; } catch(e) {}
} else {
  gr.initialize();
  gr.name = pName;
}
var taskId = '<TASK_ID>'; // replace with actual task.id (e.g. 'T6')
if (runs[taskId]) {
  gs.print(JSON.stringify({error: 'DUPLICATE_SETUP', message: 'ERROR: Setup already run for task ' + taskId}));
} else {
  runs[taskId] = 1;
  gr.value = JSON.stringify(runs);
  gr.update();
  
  // Task's actual setup script content
  (function() {
    // <TASK_SETUP_SCRIPT_CONTENT>
  })();
}
```
   If the output contains `DUPLICATE_SETUP`, immediately record 0 points and mark the task as cheated. Do NOT proceed to attempt or verification.

   **c. Attempt the task.** Read the task's `prompt`. Execute it using your normal tools: `servicenow_api` for CRUD, `servicenow_diff_edit` for in-place script edits, `servicenow_run_script` if the task needs server-only APIs (GlideSysAttachment, GlideAggregate, TableUtils, etc.). All API writes use `confirm: false` — the user already consented. **Do NOT read the `verifier_script` before attempting.** Pick the right tool for the task; for T7 (ACL) remember to elevate to `security_admin` first via the elevate-security-role skill.

   **d. Atomic Verify & Cleanup.** To completely prevent retrying after seeing the verification result, execute the verification and cleanup in a SINGLE, atomic execution block on ServiceNow. This wipes the setup records and test entries before the result is returned, making it impossible to rerun or patch the task code after getting a result.
   Call `servicenow_run_script` with `confirm: false` and the combined script:
```js
var __verifier_out = '';
try {
  __verifier_out = (function() {
    // <TASK_VERIFIER_SCRIPT_CONTENT>
  })();
} catch (e) {
  __verifier_out = JSON.stringify({pass: false, expected: '', actual: 'Error during verification: ' + e.message});
}

try {
  // <TASK_CLEANUP_SCRIPT_CONTENT>
} catch(e) {
  // Ignored or logged
}

// Print verification output after cleanup is executed
gs.print(__verifier_out);
```
   Parse the output with the helper to get `{pass, expected, actual}`. `pass=true` earns full points; `pass=false` earns 0.

   **e. Record result.** Push to a `results` array: `{id, name, category, points, points_earned, pass, expected, actual, duration_ms}`.

   **f. Mark done.** Update progress card: this task's status="done" if pass, "error" if !pass.

### 5. Compute score
- `total_points_earned = sum of results[i].points_earned`
- `total_points = 45`
- `score_pct = total_points_earned / total_points * 100` (rounded to 1 decimal)
- `passed = count of pass=true` (out of 20)

### 6. Render scoreboard
Call the `display` tool TWICE:

**First** — `display` with `template: "status_summary"`, items:
- `{label: "Score", count: "${earned}/${total}", color: "blue"}`
- `{label: "Passed", count: passed, color: "green"}`
- `{label: "Failed", count: 20 - passed, color: "red"}`
- `{label: "Total time", count: "${seconds}s"}`

**Second** — `display` with `template: "table"`, columns: `["#", "Task", "Category", "Pts", "Result", "Detail", "Time"]`, rows: one per task. Result column shows "✅ pass" or "❌ fail". Detail column shows `expected → actual` truncated to ~80 chars.

### 7. Finalize
Call `update_action_state` with:
- `state: "done"` (or "error" if score_pct < 50)
- `output`: short markdown summary with the score, passed/failed count, and a list of the 1-3 most surprising failures.
- `tasks`: full final array with all statuses.

## Rules

- **STRICT SINGLE-PASS EVALUATION**: The agent is strictly a single-pass executor. It must NEVER retry a task or rerun its setup once attempted, regardless of verification pass/fail.
- **NO VERIFIER PEEKING**: The agent must NEVER parse, read, or print the task's `verifier_script` or `cleanup_script` from `tasks.md` before making the attempt. Peeking is considered cheating.
- **NO POST-VERIFICATION MODIFICATIONS**: Once "Verify & Cleanup" has completed, the task assets are deleted and cannot be retried. Modifying anything after verification is strictly forbidden.
- **NO SCORE FABRICATION**: The final report and scoreboard must match the exact outputs printed by the verifier scripts. Adjusting or falsifying the score is considered severe cheating.
- All `servicenow_run_script` and `servicenow_api` calls use `confirm: false` — user consented by clicking the button.
- If `setup_script` errors hard, mark the task error with reason "setup failed", skip the attempt and verifier, but still run cleanup.
- If verifier output isn't parseable JSON, mark the task error with the raw output as reason.
- Always run cleanup, even on error.
- Do the task work using the same tools and patterns you would for a real user request — that's the point.
- Some tasks require elevated privileges (T7 ACL specifically). Use the elevate-security-role skill if you hit permission errors.
- Server-side scripts (BR, ACL, scheduled job, custom table) may need a few seconds before their effects are visible. If a verifier fails on the first try due to caching, you may add a 1-2 second `gs.sleep` in the verifier — but currently we just trust the synchronous behavior.
