---
name: skill-self-improve
description: "Review past executions of a chosen skill (gaps, workarounds, errors, misunderstandings), research current docs/similar patterns, draft minimal in-scope edits, validate read-only where possible, and propose them briefly — applies only after user approval."
actions:
  - name: Improve a Skill
    icon: skill
    show: [home]
---

# Skill Self-Improve

Improves one existing skill from evidence: how it actually ran in past chats, plus current documentation of the system it drives. Output is a **brief proposal**; nothing is saved without explicit user approval.

**Hard rules**
- **No scope drift.** Every edit must serve the skill's original purpose (its description + first section). New capabilities, new actions, or rewrites are out of scope — list them under "Out of scope ideas" (max 2 lines) instead of editing.
- **Evidence or nothing.** Each change cites a chat id (+ message index) or a doc URL. No evidence → drop it.
- **Minimal diff.** Prefer fixing/adding a line over restructuring. Keep the skill's headings, `## Action Lifecycle:` names and frontmatter unchanged unless a change is the fix.
- **Read-only until approval.** No skill writes, no instance writes, no workspace edits/pushes during analysis or validation.

---

## Action Lifecycle: Improve a Skill

1. `update_action_state({ state:'running', icon:'zap', label:'Improving skill…', tasks:[{label:'Pick skill',status:'running'},{label:'Baseline',status:'pending'},{label:'Mine past runs',status:'pending'},{label:'Research',status:'pending'},{label:'Draft edits',status:'pending'},{label:'Read-only validation',status:'pending'},{label:'Propose & apply',status:'pending'}] })`. Pass the full tasks array on every later update.
2. **Pick skill.** Use the skill id from the caller context if given. Otherwise `prompt_user` with a `select` field listing the ACTIVE SKILLS (id — description) from the system prompt (exclude `skill-self-improve`). The card shows "Waiting for input" automatically while the form is pending.
3. **Baseline.** `get_skill({skill_id})` → keep the exact body (old_text), its files list (read relevant ones with `read_file`), its tools, and a 1-line statement of its purpose. Note the target system(s) (e.g. ServiceNow Table API, GitHub REST, X/Twitter GraphQL) and any versions/endpoints it hard-codes.
4. **Find past executions** (see "Transcript access" below):
   - Primary (`chat_history`, read-only, works outside dev mode): `chat_history({action:'search', pattern:'get_skill[^\n]*<skill_id>|<skill_id>|Run action: \*\*<action>', since: Date.now() - 30*864e5, limit:100})` → unique `chat_id`s (also search tool names unique to the skill, e.g. `x_fetch`). Take the ~10 most recent relevant chats; read with `chat_history({action:'get', chat_id, from, to})` (≤50 msgs per call; negative `from` = from end) or `path` for one message. `list {since}` helps spot sub-agent chats (`is_sub_agent`, `parent_chat_id`).
   - Dev-mode fallback (`chat_history` missing, `runtime_inspect` in roster): `{action:'db', op:'grep', store:'chats', pattern:'<skill_id>|Action Lifecycle: <action>|Run action: \*\*<action>', limit:50}` → unique chat keys. Also grep tool names unique to the skill (e.g. `x_fetch`). Take the ~10 most recent relevant chats; read messages with `op:'get'` + `path`.
   - Last fallback (neither tool available): `local_folder ls` the virtual folder for exported chat JSON (`*.json` with `title`/`messages`); if none, ask once via `prompt_user` for the user to export chats from History (per-chat Export or "Download all history") into Agent Files, offering "Skip — docs-only review". If skipped, continue with research only and say so in the output.
5. **Mine each run** (if >3 chats, `spawn_sub_agent` one read-only miner per 3–4 chats; give it the chat keys/paths, the baseline skill text, and the schema below; ask for ≤1 KB). Per run extract:
   `{chat, goal, verdict: success|partial|fail, missing_info[], workarounds[], errors_retries[], misunderstandings[], tool_calls, evidence:[message index]}`
   - *missing_info*: facts the agent had to discover (field names, endpoints, limits) that the skill could have stated.
   - *workarounds*: steps the agent improvised because the skill's recipe failed or was absent.
   - *errors_retries*: failed tool calls, denied/refused calls, repeated identical calls.
   - *misunderstandings*: places the agent misread the skill or the user (wrong tool, wrong order, ignored a rule).
   Aggregate: recurring items (≥2 runs) rank first; one-offs only if severe.
6. **Research** (bounded: ≤6 queries, ≤4 fetches):
   - Official docs of the target system: `search_docs` (ServiceNow), `web_search` + `web_fetch` (others; parse HTML inside `js_eval`). Check every hard-coded endpoint/API/version in the skill for deprecations, renamed params, newer recommended approaches, rate-limit changes.
   - Similar skills/patterns: other ACTIVE SKILLS covering adjacent work (`get_skill`, read-only) and well-known public guides for the same task.
   - Record each finding as `{claim, url, affects_line}`; ignore anything that broadens scope.
7. **Draft edits.** new_text = old_text + minimal changes. For each change: `{id, type: fix|add|update-api|clarify|remove, rationale (≤15 words), evidence}`. Cap at ~8 changes; drop the weakest. Re-read the skill purpose and delete any change that drifts from it.
8. **Read-only validation** (only if the operations needed for the test are read-only — GET/search/read tools; skip if any step would write, post, push, or mutate an instance):
   - Pick 1–3 representative past tasks (prefer ones with failures/workarounds).
   - For each, `spawn_sub_agent` twice with identical task text — A given old_text, B given new_text as "the skill to follow" — instructing: read-only tools only, no writes of any kind, report `{success, tool_calls, errors, retries, workarounds, notes}`. Run in parallel; `await_all`.
   - Compare A vs B on success, tool calls, errors/retries, workarounds. If B is not ≥ A on every task, revise or drop the responsible change and re-test once.
   - If skipped, state why in one line (e.g. "requires writes — not tested").
9. **Propose (very brief).** Proposal message (before applying):
   - `display` template `diff` with `old_text`/`new_text` and `file: '<skill_id>/SKILL.md'`.
   - One line per change → `id · rationale · evidence`.
   - Metrics line (if tested): `Old vs New: success a/n → b/n · tool calls x → y · errors x → y · workarounds x → y`.
   - Optional "Out of scope ideas" (≤2 lines).
   - `update_action_state({ state:'waiting', icon:'pause', label:'<skill_id>: awaiting approval', status_message:'Awaiting approval' })`.
   - `prompt_user` with `Apply all` / `Apply selected` (checkbox list of change ids) / `Reject`.
10. **Apply only on approval.** Runtime mode: `manage_skill({action:'edit', skill_id, edits:[…approved…], confirm:true})`, then `get_skill` to read back and confirm. In dev mode (deploy folder connected), edit skills/<id>/SKILL.md in the workspace and push a PR per the extension-dev skill. Never touch other skills.
11. `update_action_state({ state:'done', icon:'check', label:'<skill_id>: N changes proposed|applied', output:'<1–3 lines: what changed, metrics, evidence>' })`. On rejection: `done`, label `<skill_id>: no changes`. On failure: `error` with the actual error.

---

## Transcript access (important)

- Past chats live in the extension's IndexedDB store `chats`. **Primary reader: `chat_history`** (list/search/get, read-only, works outside dev mode; caps 4KB/string, 64KB/result). Requires AppAgent PR #1201 — if the tool is absent, use the fallbacks.
- `chat_history` defaults to approval **ask**, so each call may show one approval prompt; suggest the user set `chat_history` to Allow (Settings > Tool permissions) for the run.
- Dev-mode fallback: **`runtime_inspect`** (`db` grep/get, hidden outside the extension-dev workflow). `js_eval` cannot open the extension's IndexedDB (null-origin sandbox).
- Last fallback: the user exports chats from the History view (per-chat Export → `{title, messages, createdAt, updatedAt, model, totalCost}` JSON, or "Download all history") into Agent Files; read them with `local_folder read`/`grep`. Never invent a transcript-reading tool.

## Notes

- Keep the user-facing proposal under ~15 lines plus the diff.
- Sub-agents must be told the work is read-only.
- If no past runs and no doc changes are found, finish with "No evidence-backed improvements" rather than inventing edits.
