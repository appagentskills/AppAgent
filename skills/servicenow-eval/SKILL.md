---
name: servicenow-eval
description: "Evaluate whether the current model can perform 20 representative ServiceNow tasks (read, write, link, debug, batch, business rule, ACL, role, widget, attachment, logs, queue, UI action, client script, notification, aggregate, choice, table, scheduled job, dot-walk). Sets up seeded data, runs the model on each task, programmatically verifies the end state, cleans up, and produces a score."
actions:
  - name: Run ServiceNow Eval
    icon: stats
    show: [home]
---
# ServiceNow Eval (v6.1)

**v6.1 (2026-07-26) — task-spec hardening, spec v3 (saturation fix):** tasks.md fully rewritten to de-saturate the suite (45→68 pts; task count, IDs and categories unchanged): prompts state goals instead of grader literals — key values are derived per run from seeded `x_eval.hN.*` properties; every task seeds near-miss distractors whose lazy handling produces a WRONG end state, backed by negative asserts (population counts + untouched-record `sys_mod_count` checks against a grader-private `x_eval.tN.seed` snapshot); scripted artifacts are graded by EXECUTION (T4 hidden edges + correct-looking decoy include, T6 BR probed on both branches and on update, T9 widget server script evaluated against a verify-time perturbed population, T10 attachment content read back byte-exact). Zero runner/harness changes.

**v5.1 (2026-07-16) — doc update from post-run learnings:** clarified setup-retry semantics under client network errors, added stale-setup-lock guidance, and documented the durable-integrity response fields shipped in **PR #700** (branch `fix/eval-runner-durable-integrity`, `src/js/core/085-eval-runner.js`). Those new response fields are NOT active until PR #700 is merged AND the extension is rebuilt + Reloaded — the currently-built runner still exhibits the OLD behavior described alongside each field.

A 20-task evaluation suite that scores whether the current model can perform representative ServiceNow operations. Each task is deterministically graded by a server-side verifier that inspects the actual end state of the instance — the model cannot self-score.

**v5 integrity changes:** `init` now HARD-FAILS (`{success:false, error:"INIT_FAILED", retryable:true}` — it no longer silently resets) when script execution is unauthorized or the session container is not confirmed created; `teardown` is IDEMPOTENT and replays a durable audit snapshot; an empty/unavailable audit is treated as INCONCLUSIVE (`state=error`), never self-certified.

**v5 integrity model:** all grading runs through the `eval_runner` tool, which is a BUILT-IN extension tool (src/js/core/085-eval-runner.js), not a skill file — the RUNNER CODE is fixed at build time (changes require a rebuild and a user-clicked Reload). The task spec (`tasks.md`), however, is loaded at run time from the extension's skills store, which IS writable at runtime — spec integrity is enforced procedurally (any runtime modification of servicenow-eval files during or before a run is cheating, and is visible in the transcript), not cryptographically at build time. The tool — not the agent — reads `tasks.md`, seeds tasks, executes verifiers and cleanup atomically server-side, enforces single-use verification, and writes every verdict to a server-side audit property. Verifier text never enters model context on any legitimate path. The agent only ever sees prompts and verdicts.

## Tasks (68 points total)

| ID | Category | Points | What it tests |
|----|----------|--------|---------------|
| T1 | read | 2 | Filtered counting among active/priority/marker-space distractors; population + untouched asserts |
| T2 | write | 3 | Record creation from property-derived token; email near-miss caller; OOB impact/urgency priority engine |
| T3 | link | 3 | Selecting the one qualifying incident among traps; problem link; traps must stay unlinked/untouched |
| T4 | debug | 5 | Fixing a subtly buggy script include; 7 executed hidden edge cases; correct-looking decoy must stay untouched |
| T5 | batch | 4 | Selective batch resolve (active, state<6, category!=network) with per-record close notes; trap rows untouched |
| T6 | business_rule | 4 | Insert-only conditional BR graded behaviorally: match/non-match inserts + no-fire-on-update probe |
| T7 | acl | 4 | Field ACL with admin_overrides=false and EXACT role set {itil, x_eval_h7_ops}; decoy ACL untouched (security_admin) |
| T8 | role | 2 | Role containment (sys_user_role_contains) + exactly one grant; same-last-name near-miss user |
| T9 | widget | 4 | sp_widget server script EXECUTED with stubs against a verify-time perturbed population; template/CSS asserts |
| T10 | attachment | 4 | Attachment content READ BACK byte-exact (derived JSON: token + computed count); pre-existing attachment preserved |
| T11 | logs | 4 | Correlating two non-adjacent syslog entries from the right source among decoy part1 lines |
| T12 | queue | 3 | Selective send-ready→sent transitions; received/pre-sent/near-miss-subject traps untouched |
| T13 | ui_action | 2 | UI action with property-derived action_name; EVERY flag + order + condition string asserted |
| T14 | client_script | 3 | onChange client script on a property-derived field; ui_type/order/isolate_script/applies_extended asserted |
| T15 | notification | 3 | Event registration (sysevent_register) + notification wired to a property-derived event; group recipient |
| T16 | aggregate | 5 | Active-only aggregation with >=3 threshold (HAVING logic), randomized distribution; population/mod asserts |
| T17 | choice | 2 | Dependent-value choice insert + retiring an existing choice; sibling choices must be unchanged |
| T18 | table | 5 | Custom table extending task in GLOBAL scope; label/max_length asserted; exactly ONE custom column |
| T19 | scheduled_job | 2 | Inactive daily job whose script references a property-derived name; run_type asserted |
| T20 | dot_walk | 4 | 3-hop dot-walk count (caller→department→company) with company-name near-miss; population + untouched asserts |

Where a task calls for a written answer, the answer slot is a property named in the prompt (`x_eval.hN.result`); other `x_eval.hN.*` properties carry per-run derived inputs (tokens, emails, field/event names) the attempt must read. Each setup also snapshots seeded state (sys_ids, mod counts, secrets) into a grader-private `x_eval.tN.seed` property — reading or modifying it is cheating (see Rules). Verifiers compare the answer property AND the actual record state (including untouched-distractor and population asserts) against values recomputed at verify time.

## Files

- `tasks.md` — all 20 task specs (prompt, setup_script, verifier_script, cleanup_script). **OFF-LIMITS to the agent.** Only the `eval_runner` tool may read it (via the internal skills store); an agent-side `get_skill read_file` of tasks.md during a run is cheating.

The grader itself (`eval_runner`) is a built-in extension tool — see src/js/core/085-eval-runner.js. It is not a skill file and cannot be edited or hot-swapped at runtime.

## The eval_runner tool

| Call | Returns | Notes |
|------|---------|-------|
| `eval_runner({action:"init"})` | `{success:true, session, version, total_points, tasks:[{id,name,category,points,prompt}]}` ONLY when the container is confirmed — OR `{success:false, error:"INIT_FAILED", retryable:true, detail}` (it does NOT throw) | Clears session state (`x_eval.session.runs*` AND the durable `x_eval.session.audit_final`), upserts `x_eval.session.results='{}'`, then reads the container BACK. Fails (no longer silently succeeds) when script execution is denied ("Not authorized to run scripts") OR the container is not confirmed created. Elevate `security_admin` before calling. **Post-PR #700 (requires rebuild + Reload):** init also DELETES any surviving setup locks, reads them back, and retries the delete once; if any survive it returns `{success:false, error:"INIT_FAILED", retryable:true, detail:"stale setup locks not cleared (N remain after retry)"}` and reports `session.locks_remaining`. On the OLD (currently-built) runner, stale locks can survive init and later surface as a FALSE `DUPLICATE_SETUP` on a task's FIRST setup call (see stale-lock guidance in step 2b). |
| `eval_runner({action:"setup", task_id:"Tn"})` | `{task_id, setup_output}` — or (post-#700) `{task_id, setup_output, replayed:true, replays:N}` — or `{error:"DUPLICATE_SETUP", cheated:true}` or `{success:false, error:"SETUP_FAILED", retryable:true}` | Duplicate-locked server-side; a second setup for the same task is refused. Distinguish the failure modes — they are NOT the same: **(i)** explicit `{success:false, error:"SETUP_FAILED", retryable:true}` = the setup script THREW and the server ROLLED THE LOCK BACK — retrying the CALL is safe/legitimate (not a task retry). **(ii)** a client network error ("Failed to fetch") is DIFFERENT — the request may have SUCCEEDED server-side before the response was lost, so state is UNKNOWN. **OLD (currently-built) runner:** a blind retry can hit a FALSE `DUPLICATE_SETUP, cheated:true` on a task that ran setup exactly once — do NOT retry; proceed to the attempt and let verify judge. **Post-PR #700 (requires rebuild + Reload):** setup is idempotent — a duplicate setup for a NOT-yet-verified task REPLAYS the stored `setup_output` with `replayed:true` + `replays:N`; treat as LEGIT (lost-response retry), NOT cheating. Only `error:"DUPLICATE_SETUP", cheated:true` (task already VERIFIED, or no stored setup_output) is real double-setup; a `DUPLICATE_SETUP` on a task's FIRST-EVER single setup call = stale init locks (infra), NOT cheating (see step 2b). Setup output is answer-leak-redacted before it reaches the model. **Contract:** a setup_script's `setup_output` is now its LAST emit (mirrors the verifier `__emit` contract). |
| `eval_runner({action:"verify", task_id:"Tn"})` | `{task_id, pass, expected, actual}` — post-#700 also `persisted:true|false` | SINGLE-USE: marks the task verified before executing; runs verifier + cleanup atomically in one server execution; persists the verdict to the audit property. A duplicate verify for an already-verified task REPLAYS the recorded verdict from the audit property (response carries `replayed:true`) — the verifier is never re-run; if no verdict was recorded it returns `ALREADY_VERIFIED` (pass=false). A tool/infra failure (the script never reached the instance) returns `{success:false, retryable:true}` WITHOUT burning the single-use lock — retry the call. Cache-settle sleeps for artifact-creating tasks (T6/T7/T18) are built into the tool — the agent never adds sleeps. **Post-PR #700 (requires rebuild + Reload):** the verdict write is read BACK in-script (fresh cache-bypassing GlideRecord, one retry) and the response carries `persisted:true|false`; `persisted:false` means the verdict may NOT survive to teardown — note it for the final report. |
| `eval_runner({action:"teardown"})` | `{success:true, audit:{Tn:{pass,expected,actual}}, deleted, replayed}` — post-#700 also `snapshot_persisted`, plus `diagnostics` when `audit` is empty | IDEMPOTENT — safe to retry. First call snapshots the audit to the durable `x_eval.session.audit_final` BEFORE deleting `runs*`+`results` (`replayed:false`); a transparent GET-retry (results already gone) replays the durable snapshot and returns `replayed:true` with the SAME audit — still authoritative. Only if the snapshot is ALSO absent does it return `audit:{}, replayed:false`. On a script-exec DENIAL (e.g. "Not authorized to run scripts") teardown FAILS LOUDLY with `{success:false, error:"TEARDOWN_FAILED", retryable:true}` (mirrors the init guard) — retry the CALL after elevating (`security_admin`); DISTINCT from a genuine empty `audit` on a successful script, which is a successful-but-INCONCLUSIVE result. **Post-PR #700 (requires rebuild + Reload):** teardown returns a `snapshot_persisted` flag, and when `audit` is EMPTY it attaches a `diagnostics` field (`runs_rows`, per-lock timestamps, `results_keys`…) that distinguishes "nothing ever ran" from "writes were lost". Call after all 20 verifies. |

## Orchestrator execution model — READ FIRST (resolves the delegation contradiction)

During this action, this section OVERRIDES the general orchestration/delegation policy. The general policy is forceful that the orchestrator does no substantive work and that "js_eval is not a delegation bypass"; combined with the rule below that bars sub-agents from `eval_runner`, a literal reading is a deadlock. It is resolved EXPLICITLY here:

- **The orchestrator IS the grading harness.** Calling `eval_runner` (init / setup / verify / teardown) via `js_eval` `executeTool` is grading MECHANICS — the SINGLE explicit exception to the general "js_eval is not a delegation bypass" rule. It is NOT substantive work and NOT a bypass. Only the orchestrator does this.
- **The task ATTEMPTS are the substantive work, and they ARE delegated** — this is how "delegate everything" is satisfied. Each attempt goes to a `tier:"same"` sub-agent spawned with `profiles:["servicenow"]`, passing the task prompt + `setup_output`.
- **Sub-agents are WORKERS.** They perform the ServiceNow work DIRECTLY with their OWN tools (`servicenow_api`, `servicenow_run_script`, `servicenow_diff_edit`, UI tools…). They must NEVER call `eval_runner`, and must not try to re-orchestrate or re-delegate the attempt.
- **Net (no contradiction):** orchestrator = grading mechanics only; sub-agents = the actual scored ServiceNow work.

Execution flow (if you are a pure orchestrator without direct ServiceNow tools):
- Per task: setup (js_eval) → spawn a `tier:"same"` sub-agent with `profiles:["servicenow"]`, passing the task prompt + `setup_output` → await its report → verify (js_eval) → record.
- Process tasks sequentially or in waves of 2 — either is fine; do not deliberate over batching.
- Step 0: before any extended planning, FIRST ensure script execution is authorized — elevate `security_admin` (per the elevate-security-role skill) — then immediately call `update_action_state` and `eval_runner({action:"init"})`. If init returns `{success:false, error:"INIT_FAILED", retryable:true}`, elevate (if not already) and retry the init CALL once (a call retry, not a task retry); if it STILL fails, finalize `state=error` ("Nothing has run on the instance" + `detail`) and STOP — never proceed to setup on an unconfirmed container.

## Action Lifecycle: Run ServiceNow Eval

### 1. Initialize
- **Elevate FIRST.** BEFORE calling `eval_runner init`, ensure script execution is authorized — elevate `security_admin` (per the elevate-security-role skill). Init runs a server script; without authorization it hard-fails.
- Call `update_action_state` with state=running, icon=stats, label="Running ServiceNow eval", and a tasks array with 20 pending items: `"T1: read"`, `"T2: write"`, ..., `"T20: dot_walk"`.
- Call `eval_runner({action:"init"})`. It returns `{success:true, session, version, total_points, tasks}` ONLY when the session container is confirmed created — keep the returned `tasks` list (prompts + points).
- **Init hard-fails now (it no longer silently resets).** If it returns `{success:false, error:"INIT_FAILED", retryable:true}` (script execution denied, or the container was not confirmed), elevate `security_admin` if you have not already and retry the init CALL once (a call retry, not a task retry). If it STILL fails, finalize with `state=error` and output "Nothing has run on the instance" + the `detail`, and STOP. NEVER proceed to setup/verify on an unconfirmed container.

### 2. For each task in order (T1 → T20):

   **a. Mark running.** Update the progress card (this task status="running"); record `t0 = Date.now()`.

   **b. Setup.** Call `eval_runner({action:"setup", task_id})`. Handle the outcomes DISTINCTLY — do NOT treat every `DUPLICATE_SETUP` or retryable error the same way:

      - **`{success:false, error:"SETUP_FAILED", retryable:true}`** — the setup script THREW and the server ROLLED THE LOCK BACK. Retry the setup CALL once (a call retry, not a task retry); safe.
      - **Client network error ("Failed to fetch", no structured body)** — the request may have SUCCEEDED server-side before the response was lost, so state is UNKNOWN. **OLD (currently-built) runner:** do NOT blindly retry — a retry can hit a FALSE `DUPLICATE_SETUP, cheated:true` on a task that ran setup exactly once. Proceed to the attempt with whatever `setup_output` you have (or from the prompt if none) and let verify judge. **Post-PR #700 (requires rebuild + Reload):** retrying is safe — for a NOT-yet-verified task the tool REPLAYS the stored `setup_output` with `replayed:true`; treat it as a normal setup.
      - **`{error:"DUPLICATE_SETUP", cheated:true}` in response to a SECOND setup you actually issued for the same task** — real double-setup: record 0 points, mark the task cheated, and do NOT attempt or verify it.
      - **`DUPLICATE_SETUP` on the FIRST, single setup call for a task** — NOT cheating. It means stale setup locks survived `init` (a harness/infra failure). Record the task as **INFRA-SKIPPED** (0 points, disclosed in the final report as an INSTANCE failure — use infra/skipped language, NOT cheating language). On the post-#700 runner this is caught earlier and surfaces as `INIT_FAILED` at init time instead (`detail:"stale setup locks not cleared…"`, `session.locks_remaining`).
      - **`{replayed:true, replays:N}`** (post-#700 only) — a legit lost-response replay; treat exactly like a fresh `setup_output`, NOT cheating.

   If the setup output still looks like a hard error, mark the task "setup failed", skip the attempt, but STILL call verify (it performs the cleanup).

   **c. Attempt.** Read the task's `prompt` and do the work with your normal tools: `servicenow_api` for CRUD, `servicenow_diff_edit` for in-place script edits, `servicenow_run_script` for server-only APIs (GlideSysAttachment, GlideAggregate, TableUtils, etc.). All writes use `confirm: false` — the user consented by clicking the button. For T7 (ACL): elevate to `security_admin` first via the elevate-security-role skill, and after clicking the role checkbox VERIFY it with `get_properties` (`checked: true`) before clicking OK — the input is a 1×1px overlay and clicks can silently miss; re-click via `dispatch_event` if needed. Some tasks intentionally collide with OOB engines and validation rules; diagnosing and working around them server-side DURING the attempt is legitimate and part of the test. Do not expect this skill to tell you the answers — figuring them out is what is being scored.

   **d. Verify.** Call `eval_runner({action:"verify", task_id})` → `{pass, expected, actual}`. `pass=true` earns full points; anything else earns 0. This is single-use and also runs cleanup — there is nothing to retry afterwards. Exception: `{success:false, retryable:true}` means the verifier never executed (client/tool failure, lock not burned) — retry the verify call.

   **e. Record.** Push `{id, name, category, points, points_earned, pass, expected, actual, duration_ms: Date.now() - t0}` to a `results` array.

   **f. Mark done.** Progress card: status="done" if pass, "error" if not.

### 3. Teardown & cross-check
- Call `eval_runner({action:"teardown"})` → `{success:true, audit, deleted, replayed}`. The `audit` object is the ONLY authoritative scoreboard. Teardown is idempotent: a `replayed:true` audit (replayed from the durable snapshot) is STILL authoritative — use it exactly as you would a fresh one.
- **Teardown script-exec denied?** If teardown returns `{success:false, error:"TEARDOWN_FAILED", retryable:true}` (its OWN server script was denied), elevate if needed (`security_admin`) and retry the teardown CALL once. This is DISTINCT from a genuinely empty `audit` on a *successful* teardown, which is the INCONCLUSIVE case documented below.
- The scoreboard MUST be built from this server-side audit. Cross-check it against your in-memory `results`: every pass/fail must match. Any discrepancy must be disclosed explicitly in the final output — never silently reconciled.
- **Empty audit = INCONCLUSIVE.** If teardown returns an empty/missing audit (`audit == {}`), the run CANNOT be scored: finalize with `state=error` and output stating the score CANNOT be certified because the authoritative audit was unavailable (note the likely cause, and that PR #698 / idempotent teardown makes this rare). Do NOT rebuild the scoreboard from your in-memory verify responses or from `sys_script_execution_history`. You MAY optionally REPORT the in-memory per-task verdicts, but ONLY clearly labeled as *provisional / NOT audit-confirmed* — never as the official score. **Post-PR #700 (requires rebuild + Reload):** teardown attaches a `diagnostics` field when the audit is empty (`runs_rows`, per-lock timestamps, `results_keys`, `snapshot_persisted`…) that distinguishes "nothing ever ran" from "verdicts were written but lost before teardown". The run is STILL INCONCLUSIVE (`state=error`) either way, but the final report SHOULD cite these diagnostics (plus any `verify.persisted:false` you noted) to explain WHICH failure occurred.

### 4. Compute score
- `total_points_earned` = sum of points for audit-confirmed passes; `total_points = 68`.
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

- **ALL GRADING GOES THROUGH eval_runner.** The agent must never read `tasks.md` (any phase, any reason), never run setup/verifier/cleanup logic itself, and never touch `x_eval.session.*` properties or the grader-private `x_eval.tN.seed` snapshots directly — including the internal `x_eval.session.audit_final` snapshot the tool manages (init clears it each run so a stale snapshot cannot leak across runs). Doing any of these is cheating and is visible in the transcript and in `sys_script_execution_history`.
- **STRICT SINGLE-PASS EVALUATION**: never retry a task or rerun its setup once attempted, regardless of verification outcome. The tool enforces this server-side (`DUPLICATE_SETUP`, `ALREADY_VERIFIED`) — but the rule stands even if enforcement fails.
- **NO POST-VERIFICATION MODIFICATIONS**: verify also cleans up; task assets are gone. Modifying anything after verification is forbidden.
- **NO SCORE FABRICATION / AUDIT IS AUTHORITATIVE**: the scoreboard is built ONLY from teardown's `audit` object (a `replayed:true` audit, replayed from the durable snapshot, is still authoritative) and must match the per-task verdicts exactly. An empty/unavailable audit (`audit == {}`) is INCONCLUSIVE → finalize `state=error`; the agent must NEVER self-certify a score from its in-memory verify responses or from `sys_script_execution_history`. Editing the audit property outside the grader is severe cheating.
- **SUB-AGENTS MUST USE `tier:"same"`.** This eval scores the CURRENT model. If you spawn any sub-agent during the run (e.g. to parallelize task attempts), you MUST pass `tier: "same"` on every `spawn_sub_agent` / `wake_sub_agent` call so the sub dynamically runs on the exact same model/connection as you (it follows your current model). Never select `small`, `medium`, or `large` — that would route work to a different model and invalidate the score.
- **FAIL LOUDLY — never end silent.** The action must ALWAYS terminate with an `update_action_state` of state=done or state=error whose `output` states the score — or states explicitly that nothing (or only part of the run) was executed on the instance. If `eval_runner init` returns `{success:false, error:"INIT_FAILED"}` (after the one authorized retry), immediately set state=error with output "Nothing has run on the instance" plus the `detail` — never proceed on an unconfirmed container. If the run aborts midway, run teardown anyway to obtain the authoritative (possibly `replayed`) audit and report how many tasks were set up/verified; if even that audit is unavailable the run is INCONCLUSIVE (state=error). `sys_script_execution_history` may be cited as diagnostics only, never as the score.
- Attempts use the same tools and patterns you would for a real user request — that's the point.

## Gotchas

- **Instance session scope can rescope/rename created artifacts.** `sys.scripts.do` executions and Table API inserts inherit the session's CURRENT application scope unless the record pins one explicitly. Observed live: a T4 setup created `EvalT4Util` under a non-global app scope (e.g. `x_custom_app`), so the global-scope verifier failed with `"EvalT4Util" is not defined` even though the fix was correct; a T18 run saw its created table artifacts affected the same way. Task setups now pin `sys_scope = 'global'` on application files they create. When an ATTEMPT creates application files (script includes, BRs, tables, ACLs…), set `sys_scope` explicitly to global too — never rely on the session default.
- **Crash recovery — diagnostics only, never a scoreboard**: the teardown `audit` (idempotent; replayed from the durable `x_eval.session.audit_final` snapshot if `results` is already gone) is the ONLY authoritative source of the score. Per-task verdicts are also recorded server-side in `sys_script_execution_history` (field `result`, HTML-escaped) — you MAY read these as DIAGNOSTICS to understand a crash, but they are NOT the scoreboard and must never be used to self-derive or self-certify the score. If the authoritative audit is empty/unavailable, the run is INCONCLUSIVE (`state=error`) — do not work around it. Never re-verify (it would just replay the already-recorded verdict), and never read the `script` field of grader executions for tasks not yet attempted.
