---
name: pr-regression-sweep
description: "Review recently merged PRs for regressions using parallel sub-agents, fix verified findings, and push a sweep PR. One-click action from the home page."
actions:
  - name: PR Regression Sweep
    icon: shield
    show: [home]
---

# PR Regression Sweep

Audit the most recently merged PRs of the connected repo for regressions, using **parallel sub-agents** as reviewers, then fix verified findings and push a single `fix/prX-Y-regression-sweep` PR.

Core principles:

- **Evidence only.** A finding must be backed by `grep`/`read` proof in the current main — never by the patch text alone. Judge code as it exists NOW (later PRs may already have fixed it).
- **Orchestrate, don't do.** Sub-agents do the heavy lifting — scoping/discovery, patch reading, and the fix implementation. The parent only scopes, triages, verifies, and pushes. Patch dumps and greps stay out of the parent context.
- **The sweep PR is itself swept next time.** Sweep PRs are not exempt from review.

---

## Action Lifecycle: PR Regression Sweep

1. **Progress card immediately**: `update_action_state({ state: 'running', icon: 'shield', label: 'PR regression sweep…', tasks: [Scope PRs, Spawn reviewers, Collect findings, Fix & push, Report] })`. Update it at every step below.

2. **Scope** — find what to review:
   - `workspace` `list` → identify the connected repo (and its PR history).
   - GitHub API (reads are silent): `GET /repos/{o}/{r}/pulls?state=all&per_page=30&sort=created&direction=desc`.
   - When the PR list + per-PR file-list fetch runs to more than a couple of calls, delegate it to a `tier: "small"` discovery sub and keep the raw lists out of the parent context — the parent just decides the scope.
   - The last sweep PR is recognizable by its branch (`*regression-sweep*`) or title ("Regression sweep over PRs #A-#B"). Scope = all **merged** PRs created after the last sweep's coverage, **including the last sweep PR itself if it was never reviewed**.
   - If nothing is unreviewed, finish early: `state: 'done'`, `output: '✅ No unreviewed merged PRs.'`, `auto_dismiss_ms: 4000`.

3. **Fresh clone**: `workspace` `clone` of the repo's main branch so reviewers judge latest code.

4. **Spawn reviewers** (`spawn_sub_agent` with explicit `tier: "medium"`, pool max = 2 concurrent — serialize beyond that):
   - One sub-agent per PR (batch several small PRs into one agent if > 4 PRs in scope).
   - Instructions per agent: fetch `GET /pulls/{n}/files` + PR body; inspect the **current** state of every touched function via workspace read/grep; hunt for undefined symbols, broken references (CSS classes/IDs never defined, renamed functions with stale callers), listener leaks, inverted conditions, missed call sites, races, null derefs; do a déroulement of the changed feature; **no edits**; report via `report_to_parent`.
   - Pass an `output_schema` like: `{pr, findings: [{id, severity (critical|major|minor), file, symbol, problem, evidence, suggested_fix}], verified_ok: []}`.
   - Keep the DEFAULT `wake_parent: true` and END your turn — the first reviewer to finish wakes you, and you triage each report AS IT ARRIVES (event-driven) instead of blocking on `await_all`. As each report lands, update the progress card with the running findings-so-far count — don't wait for all reviewers before the first user-visible status. Escalate an individual reviewer only if its findings warrant it (`wake_sub_agent({ tier: "large" })`); don't raise the whole fan-out. Do NOT use `wake_parent: false` here.

5. **Triage & fix**:
   - Deduplicate findings; re-verify each critical/major finding yourself with one targeted `workspace` `read` before editing.
   - Delegate the actual fix edits to an implementation sub — `tier: "medium"` for routine fixes, `tier: "large"` for subtle/cross-cutting ones; the parent stays in the triage/verify/push role. Fix critical + major (and trivial minors); skip speculative refactors.
   - Run the **feature-deroulement** skill mental walkthrough over your own fixes.

6. **Push**: `workspace` `push` with `branch_name: fix/pr{A}-{B}-regression-sweep`, a PR title like "Regression sweep over PRs #A-#B: N fixes", and a body listing each finding (severity, file, problem, fix). If nothing needed fixing, push nothing and report findings as ✅.

7. **Report**: `update_action_state({ state: 'done', icon: 'check', label: 'N findings, M fixed', output: markdown summary with PR link })`. Remind the user to **merge + Reload** to deploy.

### Notes

- Findings that are real but out of scope (pre-existing bugs not introduced by the reviewed PRs) go in the report under "pre-existing", not in the fix PR.
- If a reviewer sub-agent errors, check `agent_status` → `resurrectable`, then `wake_sub_agent` to resume rather than respawning.
- Never `manage_skill`-edit this skill on a connected-extension setup — its source is `skills/pr-regression-sweep/SKILL.md` in the repo.
